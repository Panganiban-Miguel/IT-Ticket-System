const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const test = require("node:test");
const XLSX = require("xlsx");

const projectRoot = path.resolve(__dirname, "..");
const ticketCount = 250;

function createWorkbook(filePath) {
    const workbook = XLSX.utils.book_new();
    const customers = [{
        "Customer ID": "C-0000000000001",
        "Name": "Existing Test Customer",
        "Email": "existing@example.test",
        "Password": "test-password",
        "Credits": 10
    }];
    const tickets = Array.from({ length: ticketCount }, (_, index) => {
        const ticket = {
            "Ticket ID": `T-${index + 1}`,
            "Customer ID": customers[0]["Customer ID"],
            "Customer Name": customers[0].Name,
            "Email": customers[0].Email,
            "Issue": `Synthetic issue ${index + 1}`,
            "Support Type": "Remote Support",
            "Status": index % 3 === 0 ? "Closed" : "Open",
            "Assigned Engineer": "",
            "Appointment Date": "",
            "Appointment Time": "",
            "Appointment Status": "Pending",
            "Created Date": "2026-01-01T00:00:00.000Z",
            "Service Result": "",
            "Appointment Duration": ""
        };

        if (index === 0) {
            ticket["Customer ID"] = "";
            ticket.Email = " EXISTING@EXAMPLE.TEST ";
        } else if (index === 1 || index === 2) {
            ticket["Customer ID"] = "";
            ticket.Email = "repair@example.test";
        } else if (index === 3) {
            ticket["Customer ID"] = " C-0000000000001 ";
            ticket["Customer Name"] = "";
            ticket.Email = "";
        }

        return ticket;
    });

    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(customers), "Customer");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(tickets), "Ticket");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([]), "Staff");
    XLSX.writeFile(workbook, filePath);
}

async function getAvailablePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
    return port;
}

async function startIsolatedApp() {
    const runtimeRoot = fs.mkdtempSync(path.join(__dirname, ".runtime-"));
    let child;

    try {
        const databaseDir = path.join(runtimeRoot, "Database");
        const publicDir = path.join(runtimeRoot, "public");
        fs.mkdirSync(databaseDir);
        fs.mkdirSync(publicDir);
        fs.copyFileSync(path.join(projectRoot, "server.js"), path.join(runtimeRoot, "server.js"));
        const workbookPath = path.join(databaseDir, "database.xlsx");
        createWorkbook(workbookPath);

        const port = await getAvailablePort();
        child = spawn(process.execPath, ["server.js"], {
            cwd: runtimeRoot,
            env: { ...process.env, PORT: String(port) },
            stdio: "ignore"
        });
        const baseUrl = `http://127.0.0.1:${port}`;

        for (let attempt = 0; attempt < 100; attempt += 1) {
            if (child.exitCode !== null) {
                throw new Error(`Test server exited with code ${child.exitCode}.`);
            }
            try {
                const response = await fetch(`${baseUrl}/api/tickets`);
                if (response.ok) {
                    return { baseUrl, child, runtimeRoot, workbookPath };
                }
            } catch {
                await new Promise(resolve => setTimeout(resolve, 50));
            }
        }
        throw new Error("Test server did not become ready within five seconds.");
    } catch (error) {
        if (child && child.exitCode === null) {
            const exited = new Promise(resolve => child.once("exit", resolve));
            child.kill();
            await exited;
        }
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
        throw error;
    }
}

async function stopIsolatedApp(app) {
    if (app.child.exitCode === null) {
        const exited = new Promise(resolve => app.child.once("exit", resolve));
        app.child.kill();
        await exited;
    }
    fs.rmSync(app.runtimeRoot, { recursive: true, force: true });
}

test("file-backed API baseline and ticket-creation behavior", async t => {
    const app = await startIsolatedApp();
    t.after(() => stopIsolatedApp(app));

    await t.test("ticket list preserves its array response and records baseline timing", async t => {
        const warmup = await fetch(`${app.baseUrl}/api/tickets`);
        assert.equal(warmup.status, 200);
        assert.equal((await warmup.json()).length, ticketCount);

        const repairedWorkbook = XLSX.readFile(app.workbookPath);
        const repairedCustomers = XLSX.utils.sheet_to_json(repairedWorkbook.Sheets.Customer);
        const repairedTickets = XLSX.utils.sheet_to_json(repairedWorkbook.Sheets.Ticket);
        assert.equal(repairedCustomers.length, 2);
        assert.equal(repairedTickets[0]["Customer ID"], "C-0000000000001");
        assert.equal(repairedTickets[1]["Customer ID"], repairedTickets[2]["Customer ID"]);
        assert.equal(repairedTickets[3]["Customer Name"], "Existing Test Customer");
        assert.equal(repairedTickets[3].Email, "existing@example.test");

        const samples = [];
        for (let sample = 0; sample < 7; sample += 1) {
            const startedAt = performance.now();
            const response = await fetch(`${app.baseUrl}/api/tickets`);
            const tickets = await response.json();
            samples.push(performance.now() - startedAt);
            assert.equal(response.status, 200);
            assert.equal(tickets.length, ticketCount);
            assert.ok(Array.isArray(tickets));
        }

        samples.sort((left, right) => left - right);
        t.diagnostic(
            `Baseline GET /api/tickets (${ticketCount} synthetic rows): median ${samples[Math.floor(samples.length / 2)].toFixed(2)} ms across ${samples.length} requests.`
        );
    });

    await t.test("rejected ticket creation does not persist an auto-created customer", async () => {
        const response = await fetch(`${app.baseUrl}/api/tickets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                customerName: "Rejected Test Customer",
                email: "rejected@example.test",
                issue: "Missing on-site support type",
                supportType: "On-site Support"
            })
        });
        assert.equal(response.status, 400);

        const workbook = XLSX.readFile(app.workbookPath);
        const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
        const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);
        assert.equal(customers.some(customer => customer.Email === "rejected@example.test"), false);
        assert.equal(tickets.length, ticketCount);
    });

    await t.test("ticket creation persists an auto-created customer", async () => {
        const response = await fetch(`${app.baseUrl}/api/tickets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                customerName: "New Test Customer",
                email: "new@example.test",
                issue: "Integration test issue",
                supportType: "Remote Support"
            })
        });
        const result = await response.json();
        assert.equal(response.status, 201);
        assert.ok(result.ticketId);

        const workbook = XLSX.readFile(app.workbookPath);
        const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
        const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);
        const createdCustomer = customers.find(customer => customer.Email === "new@example.test");
        const createdTicket = tickets.find(ticket => ticket["Ticket ID"] === result.ticketId);
        assert.ok(createdCustomer);
        assert.equal(createdCustomer["Customer ID"], "C-0000000000003");
        assert.equal(createdTicket["Customer ID"], createdCustomer["Customer ID"]);
    });

    await t.test("ticket creation matches an existing customer by normalized email", async () => {
        const response = await fetch(`${app.baseUrl}/api/tickets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                customerName: "Existing Test Customer",
                email: " EXISTING@EXAMPLE.TEST ",
                issue: "Existing customer lookup",
                supportType: "Remote Support"
            })
        });
        const result = await response.json();
        assert.equal(response.status, 201);

        const workbook = XLSX.readFile(app.workbookPath);
        const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
        const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);
        const createdTicket = tickets.find(ticket => ticket["Ticket ID"] === result.ticketId);
        assert.equal(customers.filter(customer => customer.Email === "existing@example.test").length, 1);
        assert.equal(createdTicket["Customer ID"], "C-0000000000001");
    });

    await t.test("exact customer ID lookup still supports ticket updates", async () => {
        const createResponse = await fetch(`${app.baseUrl}/api/tickets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                customerId: "C-0000000000001",
                issue: "Exact customer ID lookup",
                supportType: "Remote Support"
            })
        });
        const createdTicket = await createResponse.json();
        assert.equal(createResponse.status, 201);

        const updateResponse = await fetch(
            `${app.baseUrl}/api/tickets/${encodeURIComponent(createdTicket.ticketId)}`,
            {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    assignedEngineer: "Test Engineer",
                    status: "In Progress",
                    appointmentStatus: "Pending"
                })
            }
        );
        assert.equal(updateResponse.status, 200);

        const workbook = XLSX.readFile(app.workbookPath);
        const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);
        const updatedTicket = tickets.find(ticket => ticket["Ticket ID"] === createdTicket.ticketId);
        assert.equal(updatedTicket["Customer ID"], "C-0000000000001");
        assert.equal(updatedTicket.Status, "In Progress");
        assert.equal(updatedTicket["Assigned Engineer"], "Test Engineer");
    });
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, beforeEach, test } = require("node:test");

const databaseDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "it-ticket-customer-directory-tests-")
);
process.env.IT_TICKET_DATABASE_DIR = databaseDirectory;

const XLSX = require("xlsx");
const app = require("../server");
delete process.env.IT_TICKET_DATABASE_DIR;

const databasePath = path.join(databaseDirectory, "database.xlsx");
const staffCredentials = {
    email: "staff@example.test",
    password: "test-only-password"
};
const customers = [
    {
        "Customer ID": "C-100",
        Name: "Test Customer",
        Email: "customer@example.com",
        Password: "customer-secret",
        Credits: 5
    },
    {
        "Customer ID": "C-200",
        Name: "Second Customer",
        Email: "second@example.com",
        Password: "another-secret",
        Credits: 2
    }
];
const tickets = [
    {
        "Ticket ID": "T-OPEN",
        "Customer ID": "C-100",
        "Customer Name": "Test Customer",
        Email: "customer@example.com",
        Issue: "Open issue",
        "Support Type": "Remote Support",
        Status: "Open",
        "Unpaid Credits": 0
    },
    {
        "Ticket ID": "T-PROGRESS",
        "Customer ID": "C-100",
        Email: "customer@example.com",
        Issue: "In progress issue",
        "Support Type": "On-site Support",
        Status: "In Progress",
        "Unpaid Credits": 1.5
    },
    {
        "Ticket ID": "T-PENDING",
        "Customer ID": "C-100",
        Email: "customer@example.com",
        Issue: "Pending workflow issue",
        "Support Type": "Email Support",
        Status: "Pending",
        "Unpaid Credits": 0
    },
    {
        "Ticket ID": "T-CLOSED",
        "Customer ID": "C-100",
        Email: "customer@example.com",
        Issue: "Closed issue",
        "Support Type": "Phone Support",
        Status: "Closed",
        "Unpaid Credits": 0.5
    },
    {
        "Ticket ID": "T-EMAIL-MATCH",
        "Customer ID": "",
        Email: "SECOND@example.com",
        Issue: "Email matched issue",
        "Support Type": "Email Support",
        Status: "Open",
        "Unpaid Credits": 0
    }
];

let server;
let baseUrl;

function writeWorkbook() {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(customers),
        "Customer"
    );
    XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet(tickets),
        "Ticket"
    );
    XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet([{
            "Staff ID": "S-100",
            Name: "Test Staff",
            Email: staffCredentials.email,
            Password: staffCredentials.password,
            Role: "Engineer",
            Department: "IT"
        }]),
        "Staff"
    );
    XLSX.writeFile(workbook, databasePath);
}

async function loginStaff() {
    const response = await fetch(`${baseUrl}/api/staff/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(staffCredentials)
    });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
}

function staffRequest(pathname, cookie) {
    return fetch(`${baseUrl}${pathname}`, {
        headers: cookie ? { Cookie: cookie } : {}
    });
}

before(async () => {
    writeWorkbook();
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(writeWorkbook);

after(async () => {
    if (server) {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
    fs.rmSync(databaseDirectory, { recursive: true, force: true });
});

test("customer directory endpoints require an authenticated staff session", async () => {
    const directoryResponse = await staffRequest("/api/staff/customers");
    const detailResponse = await staffRequest("/api/staff/customers/C-100");

    assert.equal(directoryResponse.status, 401);
    assert.equal(detailResponse.status, 401);
});

test("customer directory returns summaries without exposing passwords", async () => {
    const cookie = await loginStaff();
    const response = await staffRequest("/api/staff/customers", cookie);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, [
        {
            id: "C-100",
            name: "Test Customer",
            email: "customer@example.com",
            credits: 5,
            totalTickets: 4
        },
        {
            id: "C-200",
            name: "Second Customer",
            email: "second@example.com",
            credits: 2,
            totalTickets: 1
        }
    ]);
    assert.equal(JSON.stringify(body).includes("customer-secret"), false);
});

test("customer detail groups workflow statuses and pending unpaid credits", async () => {
    const cookie = await loginStaff();
    const response = await staffRequest("/api/staff/customers/C-100", cookie);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.customer, {
        id: "C-100",
        name: "Test Customer",
        email: "customer@example.com",
        credits: 5
    });
    assert.deepEqual(body.ticketCounts, {
        total: 4,
        open: 1,
        inProgress: 2,
        pendingPayment: 2,
        closed: 1
    });
    assert.deepEqual(
        body.tickets.inProgress.map(ticket => ticket.ticketId),
        ["T-PROGRESS", "T-PENDING"]
    );
    assert.deepEqual(
        body.tickets.pendingPayment.map(ticket => ticket.ticketId),
        ["T-PROGRESS", "T-CLOSED"]
    );
    assert.equal(JSON.stringify(body).includes("customer-secret"), false);
    assert.equal(Object.hasOwn(body.customer, "password"), false);
    assert.equal(Object.hasOwn(body.tickets.open[0], "Email"), false);
});

test("customer detail returns 404 for an unknown customer ID", async () => {
    const cookie = await loginStaff();
    const response = await staffRequest("/api/staff/customers/C-404", cookie);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.message, "Customer not found.");
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, beforeEach, test } = require("node:test");

const databaseDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "it-ticket-system-tests-")
);
process.env.IT_TICKET_DATABASE_DIR = databaseDirectory;

const XLSX = require("xlsx");
const app = require("../server");
delete process.env.IT_TICKET_DATABASE_DIR;

const databasePath = path.join(databaseDirectory, "database.xlsx");
const lockPath = path.join(databaseDirectory, "database.xlsx.lock");
const initialTicket = {
    "Ticket ID": "T-100",
    "Customer ID": "C-100",
    "Customer Name": "Test Customer",
    "Email": "customer@example.com",
    "Issue": "Cannot access email",
    "Support Type": "Remote Support",
    "Status": "Open",
    "Assigned Engineer": "",
    "Appointment Status": "Pending",
    "Service Result": ""
};
const staffCredentials = {
    email: "staff@example.test",
    password: "test-only-password"
};

let server;
let baseUrl;

function writeWorkbook({
    includeCustomerSheet = true,
    includeServiceReportSheet = true
} = {}) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet([initialTicket]),
        "Ticket"
    );

    if (includeCustomerSheet) {
        XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.json_to_sheet([{
                "Customer ID": "C-100",
                Name: "Test Customer",
                Email: "customer@example.com",
                Password: "temporary-test-password",
                Credits: 5
            }]),
            "Customer"
        );
    }

    if (includeServiceReportSheet) {
        XLSX.utils.book_append_sheet(
            workbook,
            XLSX.utils.json_to_sheet([{
                "Report ID": "SR-100",
                "Ticket ID": "T-100",
                "Engineer": "Test Engineer",
                "ServiceMode": "On-site",
                "Onsite": "Yes",
                "Date": "2026-10-02",
                "SignInTime": "09:00",
                "SignOutTime": "10:00",
                "HoursSpent": 1,
                "TasksDone": "Initial work",
                "Resolution": "Initial resolution"
            }]),
            "ServiceReport"
        );
    }
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

async function createOnSiteTicket(onSiteSupportType = "Maintenance", appointmentDuration = 1) {
    const response = await fetch(`${baseUrl}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerId: "C-100",
            issue: `Test ${onSiteSupportType} service`,
            supportType: "On-site Support",
            onSiteSupportType,
            appointmentDate: "2099-01-01",
            appointmentTime: "12:00",
            appointmentDuration
        })
    });
    const body = await response.json();

    assert.equal(response.status, 201, body.message);
    return body.ticketId;
}

async function submitServiceReport(ticketId, signInTime = "09:00", signOutTime = "10:00", method = "POST") {
    return fetch(`${baseUrl}/api/tickets/${ticketId}/service-report`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            serviceMode: "On-site",
            date: "2026-10-05",
            signInTime,
            signOutTime,
            resolution: "Service completed"
        })
    });
}

before(async () => {
    writeWorkbook();
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
    if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
    }
    writeWorkbook();
});

after(async () => {
    if (server) {
        await new Promise((resolve, reject) => {
            server.close(error => error ? reject(error) : resolve());
        });
    }
    fs.rmSync(databaseDirectory, { recursive: true, force: true });
});

test("GET /api/tickets returns the current ticket list", async () => {
    const response = await fetch(`${baseUrl}/api/tickets`);
    const tickets = await response.json();

    assert.equal(response.status, 200);
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0]["Ticket ID"], initialTicket["Ticket ID"]);
});

test("responses include baseline security headers", async () => {
    const response = await fetch(`${baseUrl}/api/tickets`);

    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("JSON requests larger than 32 KB receive a JSON 413 response", async () => {
    const response = await fetch(`${baseUrl}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ issue: "x".repeat(40 * 1024) })
    });
    const body = await response.json();

    assert.equal(response.status, 413);
    assert.match(body.message, /32 KB limit/);
});

test("POST /api/tickets creates a ticket for an existing customer", async () => {
    const response = await fetch(`${baseUrl}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerId: "C-100",
            issue: "New staff-created issue",
            supportType: "Remote Support"
        })
    });
    const body = await response.json();
    const workbook = XLSX.readFile(databasePath);
    const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);

    assert.equal(response.status, 201);
    assert.ok(body.ticketId);
    assert.equal(tickets.length, 2);
    assert.equal(tickets[1].Issue, "New staff-created issue");
});

test("POST /api/tickets charges the rounded estimate for billable on-site support", async () => {
    const ticketId = await createOnSiteTicket("Maintenance", 1.2);
    const workbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    const ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);

    assert.equal(customers[0].Credits, 3.5);
    assert.equal(ticket["Appointment Duration"], 1.5);
    assert.equal(ticket["Credits Charged"], 1.5);
    assert.equal(ticket["Credit Settlement Status"], "Pending");
});

test("POST /api/tickets rejects an on-site request when the estimate exceeds available credits", async () => {
    const response = await fetch(`${baseUrl}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerId: "C-100",
            issue: "Over-budget on-site service",
            supportType: "On-site Support",
            onSiteSupportType: "Maintenance",
            appointmentDate: "2099-01-01",
            appointmentTime: "12:00",
            appointmentDuration: 6
        })
    });
    const body = await response.json();
    const workbook = XLSX.readFile(databasePath);
    const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);

    assert.equal(response.status, 400);
    assert.match(body.message, /only has 5 credit/);
    assert.equal(tickets.length, 1);
    assert.equal(customers[0].Credits, 5);
});

test("on-site Projects do not consume credits when requested or reported", async () => {
    const ticketId = await createOnSiteTicket("Project", 1);
    const afterRequest = XLSX.utils.sheet_to_json(
        XLSX.readFile(databasePath).Sheets.Customer
    );
    const response = await submitServiceReport(ticketId, "", "");
    const body = await response.json();
    const workbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    const ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);

    assert.equal(afterRequest[0].Credits, 5);
    assert.equal(response.status, 201);
    assert.match(body.message, /Project tickets are exempt/);
    assert.equal(customers[0].Credits, 5);
    assert.equal(ticket["Credit Settlement Status"], "Exempt");
    assert.equal(body.report["Billable Credits"], 0);
});

test("service report settlement rounds actual work up to half-hour increments and refunds the estimate difference", async () => {
    const ticketId = await createOnSiteTicket("Maintenance", 1.5);
    const response = await submitServiceReport(ticketId, "09:00", "09:12");
    const body = await response.json();
    const workbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    const ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);

    assert.equal(response.status, 201);
    assert.equal(body.report.HoursSpent, 0.2);
    assert.equal(body.report["Billable Credits"], 0.5);
    assert.equal(body.creditSettlement.refundedCredits, 1);
    assert.equal(customers[0].Credits, 4.5);
    assert.equal(ticket["Credits Charged"], 0.5);
    assert.equal(ticket["Unpaid Credits"], 0);
});

test("billable on-site reports without a positive work duration are rejected without refunding the estimate", async () => {
    const ticketId = await createOnSiteTicket("Maintenance", 1);
    const response = await submitServiceReport(ticketId, "", "");
    const body = await response.json();
    const workbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    const ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);

    assert.equal(response.status, 400);
    assert.match(body.message, /requires sign-in and sign-out times/);
    assert.equal(customers[0].Credits, 4);
    assert.equal(ticket["Credit Settlement Status"], "Pending");
});

test("service report settlement deducts affordable additional half-hour credits", async () => {
    const ticketId = await createOnSiteTicket("Maintenance", 1);
    const response = await submitServiceReport(ticketId, "09:00", "10:12");
    const body = await response.json();
    const workbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);

    assert.equal(response.status, 201);
    assert.equal(body.creditSettlement.additionalCredits, 0.5);
    assert.equal(body.creditSettlement.unpaidCredits, 0);
    assert.equal(customers[0].Credits, 3.5);
});

test("service report settlement charges additional credits and flags any unaffordable remainder", async () => {
    const ticketId = await createOnSiteTicket("Maintenance", 1);
    const workbookBeforeReport = XLSX.readFile(databasePath);
    const customersBeforeReport = XLSX.utils.sheet_to_json(workbookBeforeReport.Sheets.Customer);
    customersBeforeReport[0].Credits = 0;
    workbookBeforeReport.Sheets.Customer = XLSX.utils.json_to_sheet(customersBeforeReport);
    XLSX.writeFile(workbookBeforeReport, databasePath);

    const response = await submitServiceReport(ticketId, "09:00", "10:12");
    const body = await response.json();
    const savedWorkbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(savedWorkbook.Sheets.Customer);
    const ticket = XLSX.utils.sheet_to_json(savedWorkbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);

    assert.equal(response.status, 201);
    assert.equal(body.report["Billable Credits"], 1.5);
    assert.equal(body.creditSettlement.additionalCredits, 0);
    assert.equal(body.creditSettlement.unpaidCredits, 0.5);
    assert.match(body.message, /0.5 unpaid credit/);
    assert.equal(customers[0].Credits, 0);
    assert.equal(ticket["Credits Charged"], 1);
    assert.equal(ticket["Unpaid Credits"], 0.5);
    assert.equal(ticket["Credit Settlement Status"], "Settled");
});

test("service report edits reconcile credits against the previous settlement", async () => {
    const ticketId = await createOnSiteTicket("Maintenance", 1);
    const initialReportResponse = await submitServiceReport(ticketId, "09:00", "10:00");
    assert.equal(initialReportResponse.status, 201);

    const editResponse = await submitServiceReport(ticketId, "09:00", "10:30", "PUT");
    const editBody = await editResponse.json();
    const workbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    const ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);

    assert.equal(editResponse.status, 200);
    assert.equal(editBody.report["Billable Credits"], 1.5);
    assert.equal(editBody.creditSettlement.additionalCredits, 0.5);
    assert.equal(customers[0].Credits, 3.5);
    assert.equal(ticket["Credits Charged"], 1.5);
});

test("deleting a ticket refunds only its unsettled estimate", async () => {
    const pendingTicketId = await createOnSiteTicket("Maintenance", 1);
    const cookie = await loginStaff();
    const pendingDelete = await fetch(`${baseUrl}/api/tickets/${pendingTicketId}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
    });
    assert.equal(pendingDelete.status, 200);
    let workbook = XLSX.readFile(databasePath);
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Customer)[0].Credits, 5);

    const settledTicketId = await createOnSiteTicket("Maintenance", 1);
    const reportResponse = await submitServiceReport(settledTicketId, "09:00", "10:00");
    assert.equal(reportResponse.status, 201);
    const reportDeleteResponse = await fetch(
        `${baseUrl}/api/tickets/${settledTicketId}/service-report`,
        { method: "DELETE" }
    );
    assert.equal(reportDeleteResponse.status, 200);
    const settledDelete = await fetch(`${baseUrl}/api/tickets/${settledTicketId}`, {
        method: "DELETE",
        headers: { Cookie: cookie }
    });
    workbook = XLSX.readFile(databasePath);

    assert.equal(settledDelete.status, 200);
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Customer)[0].Credits, 4);
});

test("POST /api/tickets rejects oversized fields without creating a customer", async () => {
    const response = await fetch(`${baseUrl}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerName: "Unpersisted Customer",
            email: "new-customer@example.com",
            issue: "x".repeat(5001),
            supportType: "Remote Support"
        })
    });
    const workbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);

    assert.equal(response.status, 400);
    assert.equal(customers.length, 1);
});

test("GET /api/tickets/:ticketId returns a ticket or 404", async t => {
    await t.test("returns an existing ticket", async () => {
        const response = await fetch(`${baseUrl}/api/tickets/T-100`);
        const ticket = await response.json();

        assert.equal(response.status, 200);
        assert.equal(ticket.Issue, initialTicket.Issue);
    });

    await t.test("returns 404 for an unknown ticket", async () => {
        const response = await fetch(`${baseUrl}/api/tickets/T-missing`);
        const body = await response.json();

        assert.equal(response.status, 404);
        assert.equal(body.message, "Ticket not found.");
    });
});

test("DELETE /api/tickets/:ticketId requires a staff session", async () => {
    const response = await fetch(`${baseUrl}/api/tickets/T-100`, {
        method: "DELETE"
    });
    const body = await response.json();
    const workbook = XLSX.readFile(databasePath);
    const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);

    assert.equal(response.status, 401);
    assert.equal(body.message, "Please log in to continue.");
    assert.equal(tickets.length, 1);
});

test("DELETE /api/tickets/:ticketId deletes a ticket for authenticated staff", async () => {
    const cookie = await loginStaff();
    const response = await fetch(`${baseUrl}/api/tickets/T-100`, {
        method: "DELETE",
        headers: { Cookie: cookie }
    });
    const body = await response.json();
    const workbook = XLSX.readFile(databasePath);
    const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);

    assert.equal(response.status, 200);
    assert.equal(body.message, "Ticket deleted successfully.");
    assert.equal(tickets.length, 0);
});

test("PUT /api/tickets/:ticketId updates and persists ticket fields", async () => {
    const response = await fetch(`${baseUrl}/api/tickets/T-100`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            status: "In Progress",
            assignedEngineer: "Test Engineer",
            appointmentStatus: "Confirmed",
            serviceResult: "Account access restored"
        })
    });
    const body = await response.json();
    const savedWorkbook = XLSX.readFile(databasePath);
    const [savedTicket] = XLSX.utils.sheet_to_json(savedWorkbook.Sheets.Ticket);

    assert.equal(response.status, 200);
    assert.equal(body.message, "Ticket updated successfully.");
    assert.equal(savedTicket.Status, "In Progress");
    assert.equal(savedTicket["Assigned Engineer"], "Test Engineer");
    assert.equal(savedTicket["Appointment Status"], "Confirmed");
    assert.equal(savedTicket["Service Result"], "Account access restored");
});

test("PUT /api/tickets/:ticketId returns 404 for an unknown ticket", async () => {
    const response = await fetch(`${baseUrl}/api/tickets/T-missing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "In Progress" })
    });
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.message, "Ticket not found.");
});

test("PUT /api/tickets/:ticketId rejects unknown status values", async () => {
    const response = await fetch(`${baseUrl}/api/tickets/T-100`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "Arbitrary Status" })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.message, "Please select a valid ticket status.");
});

test("POST service report rejects invalid service modes", async () => {
    const response = await fetch(`${baseUrl}/api/tickets/T-100/service-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceMode: "Unrecognized" })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.message, "Please select a valid service mode.");
});

test("POST service reports creates the missing sheet and keeps reports linked to each ticket", async () => {
    writeWorkbook({ includeServiceReportSheet: false });

    const ticketResponse = await fetch(`${baseUrl}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerId: "C-100",
            issue: "A second ticket with its own service report",
            supportType: "Remote Support"
        })
    });
    const ticketBody = await ticketResponse.json();
    assert.equal(ticketResponse.status, 201);

    const reportsToCreate = [
        {
            ticketId: "T-100",
            resolution: "First ticket resolution"
        },
        {
            ticketId: ticketBody.ticketId,
            resolution: "Second ticket resolution"
        }
    ];

    for (const { ticketId, resolution } of reportsToCreate) {
        const response = await fetch(`${baseUrl}/api/tickets/${ticketId}/service-report`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                serviceMode: "Remote",
                date: "2026-10-05",
                resolution
            })
        });

        assert.equal(response.status, 201);
    }

    const savedWorkbook = XLSX.readFile(databasePath);
    assert.ok(savedWorkbook.SheetNames.includes("ServiceReport"));

    for (const { ticketId, resolution } of reportsToCreate) {
        const response = await fetch(`${baseUrl}/api/tickets/${ticketId}/service-reports`);
        const reports = await response.json();

        assert.equal(response.status, 200);
        assert.equal(reports.length, 1);
        assert.equal(reports[0]["Ticket ID"], ticketId);
        assert.equal(reports[0].Resolution, resolution);
    }
});

test("POST service report preserves supported legacy service-mode aliases", async () => {
    const response = await fetch(`${baseUrl}/api/tickets/T-100/service-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceMode: "yes" })
    });
    const body = await response.json();

    assert.equal(response.status, 201);
    assert.equal(body.report.ServiceMode, "On-site");
});

test("POST service report accepts legacy onsite string values", async t => {
    for (const [onsite, expectedMode] of [["yes", "On-site"], ["no", "Remote"]]) {
        await t.test(`maps onsite=${onsite} to ${expectedMode}`, async () => {
            const response = await fetch(`${baseUrl}/api/tickets/T-100/service-report`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ onsite })
            });
            const body = await response.json();

            assert.equal(response.status, 201);
            assert.equal(body.report.ServiceMode, expectedMode);
        });
    }
});

test("POST service report rejects unsupported onsite values", async () => {
    const response = await fetch(`${baseUrl}/api/tickets/T-100/service-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ onsite: "maybe" })
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.match(body.message, /supported legacy service-mode value/);
});

test("PUT service report accepts legacy onsite values and rejects unknown ones", async t => {
    await t.test("accepts legacy no and maps it to Remote", async () => {
        const response = await fetch(`${baseUrl}/api/tickets/T-100/service-report`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ onsite: "no" })
        });
        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.report.ServiceMode, "Remote");
    });

    await t.test("rejects unknown onsite strings", async () => {
        const response = await fetch(`${baseUrl}/api/tickets/T-100/service-report`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ onsite: "sometimes" })
        });
        const body = await response.json();

        assert.equal(response.status, 400);
        assert.match(body.message, /supported legacy service-mode value/);
    });
});

test("PUT /api/tickets/:ticketId returns a JSON 500 when workbook reading fails", async () => {
    fs.unlinkSync(databasePath);

    const response = await fetch(`${baseUrl}/api/tickets/T-100`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "In Progress" }),
        signal: AbortSignal.timeout(2000)
    });
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(body.message, "Unable to update ticket.");
});

test("PUT /api/tickets/:ticketId returns 409 when the workbook is locked", async () => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid }));

    const response = await fetch(`${baseUrl}/api/tickets/T-100`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "In Progress" })
    });
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.match(body.message, /Another save is already in progress/);
});
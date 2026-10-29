const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, beforeEach, test } = require("node:test");

const databaseDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "it-ticket-system-tests-")
);
process.env.IT_TICKET_DATABASE_DIR = databaseDirectory;
process.env.IT_TICKET_LOGIN_RATE_LIMIT_MAX = "100";

const XLSX = require("xlsx");
const app = require("../server");
delete process.env.IT_TICKET_DATABASE_DIR;
delete process.env.IT_TICKET_LOGIN_RATE_LIMIT_MAX;

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
                Credits: 20
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

async function createOnSiteTicket(
    onSiteSupportType = "Maintenance",
    appointmentDuration = 1,
    appointmentTime = "12:00",
    appointmentDate = "2099-01-01",
    projectDayMode = "calendar",
    projectDays = 2
) {
    const response = await fetch(`${baseUrl}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerId: "C-100",
            issue: `Test ${onSiteSupportType} service`,
            supportType: "On-site Support",
            onSiteSupportType,
            appointmentDate,
            appointmentTime,
            appointmentDuration:
                onSiteSupportType === "Project"
                    ? projectDays
                    : appointmentDuration,
            projectDays:
                onSiteSupportType === "Project"
                    ? projectDays
                    : null,
            appointmentAddress: "100 Test Street",
            projectDayMode
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

async function submitProjectSession(
    ticketId,
    appointmentId,
    date,
    signInTime,
    signOutTime,
    projectComplete = false,
    method = "POST"
) {
    return fetch(`${baseUrl}/api/tickets/${ticketId}/service-report`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            appointmentId,
            serviceMode: "On-site",
            date,
            signInTime,
            signOutTime,
            projectComplete,
            resolution: "Project service session"
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
            supportType: "Remote Support",
            projectDayMode: null
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

    assert.equal(customers[0].Credits, 18.5);
    assert.equal(ticket["Appointment Duration"], 1.5);
    assert.equal(ticket["Credits Charged"], 1.5);
    assert.equal(ticket["Credit Settlement Status"], "Pending");
});

test("on-site ticket submission auto-assigns a technician and flags unavailable visits for scheduling", async () => {
    const firstTicketId = await createOnSiteTicket("Maintenance", 1, "08:00");
    const firstResponse = await fetch(
        `${baseUrl}/api/tickets/${encodeURIComponent(firstTicketId)}/appointments`,
        { headers: { Cookie: await loginStaff() } }
    );
    const firstAppointments = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(firstAppointments.length, 1);
    assert.equal(firstAppointments[0]["Staff ID"], "S-100");
    assert.equal(firstAppointments[0].Status, "Pending");

    const secondTicketId = await createOnSiteTicket("Maintenance", 1, "08:30");
    const workbook = XLSX.readFile(databasePath);
    const appointments = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment);
    const secondAppointment = appointments.find(
        appointment => appointment["Ticket ID"] === secondTicketId
    );
    assert.equal(secondAppointment["Staff ID"], "");
    assert.equal(secondAppointment.Status, "Reschedule Required");
    assert.match(secondAppointment["Scheduling Note"], /No eligible technician/);
});

test("staff can create an appointment for a selected eligible technician with conflict checks", async () => {
    const ticketId = await createOnSiteTicket("Maintenance", 1, "12:00");
    const workbook = XLSX.readFile(databasePath);
    const roster = XLSX.utils.sheet_to_json(workbook.Sheets.StaffRoster);
    roster.push({
        "Staff ID": "S-200",
        Name: "Second Engineer",
        Role: "Engineer",
        Active: "Yes"
    });
    workbook.Sheets.StaffRoster = XLSX.utils.json_to_sheet(roster);
    const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);
    const ticket = tickets.find(row => row["Ticket ID"] === ticketId);
    ticket["Assigned Staff ID"] = "S-200";
    ticket["Assigned Engineer"] = "Second Engineer";
    workbook.Sheets.Ticket = XLSX.utils.json_to_sheet(tickets);
    XLSX.writeFile(workbook, databasePath);

    const cookie = await loginStaff();
    const createResponse = await fetch(
        `${baseUrl}/api/staff/tickets/${encodeURIComponent(ticketId)}/appointments`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Cookie: cookie
            },
            body: JSON.stringify({
                staffId: "S-200",
                address: "Second visit address",
                date: "2099-01-01",
                time: "12:00",
                durationHours: 1
            })
        }
    );
    const created = await createResponse.json();
    assert.equal(createResponse.status, 201, created.message);
    assert.equal(created.appointment["Staff ID"], "S-200");

    const conflictResponse = await fetch(
        `${baseUrl}/api/staff/tickets/${encodeURIComponent(ticketId)}/appointments`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Cookie: cookie
            },
            body: JSON.stringify({
                staffId: "S-200",
                address: "Conflicting visit address",
                date: "2099-01-01",
                time: "12:00",
                durationHours: 1
            })
        }
    );
    assert.equal(conflictResponse.status, 409);

    const unassignedTechnicianResponse = await fetch(
        `${baseUrl}/api/staff/tickets/${encodeURIComponent(ticketId)}/appointments`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Cookie: cookie
            },
            body: JSON.stringify({
                staffId: "S-100",
                address: "Wrong staff visit address",
                date: "2099-01-01",
                time: "14:00",
                durationHours: 1
            })
        }
    );
    assert.equal(unassignedTechnicianResponse.status, 400);
    const savedAppointments = XLSX.utils.sheet_to_json(
        XLSX.readFile(databasePath).Sheets.Appointment
    );
    assert.equal(savedAppointments.length, 2);
    assert.equal(savedAppointments[1]["Staff ID"], "S-200");
});

test("staff can view available appointment assignees, reassign, and leave a visit requiring scheduling", async () => {
    const firstTicketId = await createOnSiteTicket("Maintenance", 1, "12:00");
    const workbook = XLSX.readFile(databasePath);
    const roster = XLSX.utils.sheet_to_json(workbook.Sheets.StaffRoster);
    roster.push({
        "Staff ID": "S-200",
        Name: "Second Engineer",
        Role: "Engineer",
        Active: "Yes"
    });
    workbook.Sheets.StaffRoster = XLSX.utils.json_to_sheet(roster);
    XLSX.writeFile(workbook, databasePath);

    const secondTicketId = await createOnSiteTicket("Maintenance", 1, "12:00");
    const appointments = XLSX.utils.sheet_to_json(
        XLSX.readFile(databasePath).Sheets.Appointment
    );
    const firstAppointment = appointments.find(row => row["Ticket ID"] === firstTicketId);
    const secondAppointment = appointments.find(row => row["Ticket ID"] === secondTicketId);
    assert.equal(firstAppointment["Staff ID"], "S-100");
    assert.equal(secondAppointment["Staff ID"], "S-200");

    const cookie = await loginStaff();
    const availableResponse = await fetch(
        `${baseUrl}/api/staff/appointments/${encodeURIComponent(firstAppointment["Appointment ID"])}/available-staff`,
        { headers: { Cookie: cookie } }
    );
    const availableStaff = await availableResponse.json();
    assert.equal(availableResponse.status, 200);
    assert.deepEqual(availableStaff.map(person => person.staffId), ["S-100"]);

    const conflictingReassignment = await fetch(
        `${baseUrl}/api/staff/appointments/${encodeURIComponent(firstAppointment["Appointment ID"])}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ staffId: "S-200" })
        }
    );
    assert.equal(conflictingReassignment.status, 409);

    const cancelSecondAppointment = await fetch(
        `${baseUrl}/api/staff/appointments/${encodeURIComponent(secondAppointment["Appointment ID"])}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ status: "Cancelled" })
        }
    );
    assert.equal(cancelSecondAppointment.status, 200);

    const reassignResponse = await fetch(
        `${baseUrl}/api/staff/appointments/${encodeURIComponent(firstAppointment["Appointment ID"])}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ staffId: "S-200" })
        }
    );
    assert.equal(reassignResponse.status, 200);
    let updatedWorkbook = XLSX.readFile(databasePath);
    let updatedAppointment = XLSX.utils.sheet_to_json(updatedWorkbook.Sheets.Appointment)
        .find(row => row["Appointment ID"] === firstAppointment["Appointment ID"]);
    let updatedTicket = XLSX.utils.sheet_to_json(updatedWorkbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === firstTicketId);
    assert.equal(updatedAppointment["Staff ID"], "S-200");
    assert.equal(updatedTicket["Visit Technician"], "Second Engineer");

    const unassignResponse = await fetch(
        `${baseUrl}/api/staff/appointments/${encodeURIComponent(firstAppointment["Appointment ID"])}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({ staffId: "" })
        }
    );
    assert.equal(unassignResponse.status, 200);
    updatedWorkbook = XLSX.readFile(databasePath);
    updatedAppointment = XLSX.utils.sheet_to_json(updatedWorkbook.Sheets.Appointment)
        .find(row => row["Appointment ID"] === firstAppointment["Appointment ID"]);
    updatedTicket = XLSX.utils.sheet_to_json(updatedWorkbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === firstTicketId);
    assert.equal(updatedAppointment["Staff ID"], "");
    assert.equal(updatedAppointment.Status, "Reschedule Required");
    assert.match(updatedAppointment["Scheduling Note"], /No technician is assigned/);
    assert.equal(updatedTicket["Appointment Status"], "Reschedule Required");
    assert.equal(updatedTicket["Visit Technician"], "");
});

test("a released early appointment allows reassignment after the actual sign-out plus travel buffer", async () => {
    const ticketId = await createOnSiteTicket("Maintenance", 1, "08:00");
    const workbook = XLSX.readFile(databasePath);
    const appointment = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Ticket ID"] === ticketId);
    const reportResponse = await fetch(`${baseUrl}/api/tickets/${ticketId}/service-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            appointmentId: appointment["Appointment ID"],
            serviceMode: "On-site",
            date: "2099-01-01",
            signInTime: "08:00",
            signOutTime: "08:30",
            resolution: "Completed early"
        })
    });
    assert.equal(reportResponse.status, 201);

    const secondTicketId = await createOnSiteTicket("Maintenance", 1, "09:30");
    const savedWorkbook = XLSX.readFile(databasePath);
    const appointments = XLSX.utils.sheet_to_json(savedWorkbook.Sheets.Appointment);
    const completedVisit = appointments.find(row => row["Appointment ID"] === appointment["Appointment ID"]);
    const nextVisit = appointments.find(row => row["Ticket ID"] === secondTicketId);
    assert.equal(completedVisit.Status, "Completed");
    assert.equal(completedVisit["Actual Start Time"], "08:00");
    assert.equal(completedVisit["Actual End Time"], "08:30");
    assert.equal(nextVisit["Staff ID"], "S-100");
});

test("a service report that overruns the booking releases conflicting later visits for rescheduling", async () => {
    const firstTicketId = await createOnSiteTicket("Maintenance", 1, "08:00");
    const secondTicketId = await createOnSiteTicket("Maintenance", 1, "09:30");
    const workbook = XLSX.readFile(databasePath);
    const firstAppointment = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Ticket ID"] === firstTicketId);
    const response = await fetch(`${baseUrl}/api/tickets/${firstTicketId}/service-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            appointmentId: firstAppointment["Appointment ID"],
            serviceMode: "On-site",
            date: "2099-01-01",
            signInTime: "08:00",
            signOutTime: "10:30",
            resolution: "Longer than estimated"
        })
    });

    assert.equal(response.status, 201);

    const updatedWorkbook = XLSX.readFile(databasePath);
    const appointments = XLSX.utils.sheet_to_json(updatedWorkbook.Sheets.Appointment);
    const nextAppointment = appointments.find(row => row["Ticket ID"] === secondTicketId);
    const nextTicket = XLSX.utils.sheet_to_json(updatedWorkbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === secondTicketId);
    assert.equal(nextAppointment["Staff ID"], "");
    assert.equal(nextAppointment.Status, "Reschedule Required");
    assert.equal(nextTicket["Appointment Status"], "Reschedule Required");
});

test("Project appointments retain unworked days, allow separate daily sessions, and release future days only when marked complete", async () => {
    const ticketId = await createOnSiteTicket(
        "Project",
        0,
        "00:00",
        "2099-01-02",
        "weekdays",
        2
    );
    let workbook = XLSX.readFile(databasePath);
    const projectAppointment = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Ticket ID"] === ticketId);

    const firstSession = await fetch(`${baseUrl}/api/tickets/${ticketId}/service-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            appointmentId: projectAppointment["Appointment ID"],
            serviceMode: "On-site",
            date: "2099-01-02",
            signInTime: "08:00",
            signOutTime: "10:00",
            resolution: "First Project workday"
        })
    });
    assert.equal(firstSession.status, 201);
    workbook = XLSX.readFile(databasePath);
    let savedProject = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Appointment ID"] === projectAppointment["Appointment ID"]);
    assert.equal(savedProject.Status, "Pending");
    assert.equal(JSON.parse(savedProject["Service Sessions"]).length, 1);

    const sameDayVisit = await createOnSiteTicket(
        "Maintenance",
        1,
        "11:00",
        "2099-01-02"
    );
    workbook = XLSX.readFile(databasePath);
    const scheduledSameDayVisit = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Ticket ID"] === sameDayVisit);
    assert.equal(scheduledSameDayVisit["Staff ID"], "S-100");

    const reservedMondayVisit = await createOnSiteTicket(
        "Maintenance",
        1,
        "09:00",
        "2099-01-05"
    );
    workbook = XLSX.readFile(databasePath);
    const unscheduledMondayVisit = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Ticket ID"] === reservedMondayVisit);
    assert.equal(unscheduledMondayVisit["Staff ID"], "");

    const finalSession = await fetch(`${baseUrl}/api/tickets/${ticketId}/service-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            appointmentId: projectAppointment["Appointment ID"],
            serviceMode: "On-site",
            date: "2099-01-05",
            signInTime: "08:00",
            signOutTime: "10:00",
            projectComplete: true,
            resolution: "Project completed"
        })
    });
    assert.equal(finalSession.status, 201);
    workbook = XLSX.readFile(databasePath);
    savedProject = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Appointment ID"] === projectAppointment["Appointment ID"]);
    assert.equal(savedProject.Status, "Completed");
    assert.equal(savedProject["Project Complete"], "Yes");
    assert.equal(JSON.parse(savedProject["Service Sessions"]).length, 2);

    const postProjectVisit = await createOnSiteTicket(
        "Maintenance",
        1,
        "11:00",
        "2099-01-05"
    );
    workbook = XLSX.readFile(databasePath);
    const scheduledNextDayVisit = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Ticket ID"] === postProjectVisit);
    assert.equal(scheduledNextDayVisit["Staff ID"], "S-100");

    const deleteResponse = await fetch(
        `${baseUrl}/api/tickets/${ticketId}/service-report`,
        { method: "DELETE" }
    );
    assert.equal(deleteResponse.status, 200);
    workbook = XLSX.readFile(databasePath);
    savedProject = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Appointment ID"] === projectAppointment["Appointment ID"]);
    const releasedNextDayVisit = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Ticket ID"] === postProjectVisit);
    assert.equal(savedProject.Status, "Pending");
    assert.equal(JSON.parse(savedProject["Service Sessions"]).length, 1);
    assert.equal(releasedNextDayVisit["Staff ID"], "");
    assert.equal(releasedNextDayVisit.Status, "Reschedule Required");
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
            appointmentAddress: "100 Test Street",
            appointmentDuration: 20.5
        })
    });
    const body = await response.json();
    const workbook = XLSX.readFile(databasePath);
    const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);

    assert.equal(response.status, 400);
    assert.match(body.message, /only has 20 credit/);
    assert.equal(tickets.length, 1);
    assert.equal(customers[0].Credits, 20);
});

test("Project days calculate estimated hours, reserve credits upfront, and settle cumulatively on completion", async () => {
    const ticketId = await createOnSiteTicket(
        "Project",
        0,
        "00:00",
        "2099-01-02",
        "weekdays",
        2
    );
    let workbook = XLSX.readFile(databasePath);
    let customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    let ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);
    const appointment = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Ticket ID"] === ticketId);

    assert.equal(customers[0].Credits, 4);
    assert.equal(ticket["Project Estimated Hours"], 16);
    assert.equal(ticket["Appointment Duration"], 2);
    assert.equal(ticket["Credits Charged"], 16);
    assert.equal(ticket["Billable Credits"], 0);
    assert.equal(ticket["Credit Settlement Status"], "Pending");
    assert.equal(appointment["Project Days"], 2);
    assert.equal(appointment["Project Day Mode"], "weekdays");

    const firstSession = await submitProjectSession(
        ticketId,
        appointment["Appointment ID"],
        "2099-01-02",
        "08:00",
        "08:30"
    );
    assert.equal(firstSession.status, 201);
    workbook = XLSX.readFile(databasePath);
    customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);
    assert.equal(customers[0].Credits, 4);
    assert.equal(ticket["Billable Credits"], 0.5);
    assert.equal(ticket["Credits Charged"], 16);
    assert.equal(ticket["Credit Settlement Status"], "Pending");

    const finalSession = await submitProjectSession(
        ticketId,
        appointment["Appointment ID"],
        "2099-01-05",
        "08:00",
        "08:30",
        true
    );
    assert.equal(finalSession.status, 201);
    const finalBody = await finalSession.json();
    workbook = XLSX.readFile(databasePath);
    customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);
    assert.equal(customers[0].Credits, 19);
    assert.equal(ticket["Billable Credits"], 1);
    assert.equal(ticket["Credits Charged"], 1);
    assert.equal(ticket["Unpaid Credits"], 0);
    assert.equal(ticket["Credit Settlement Status"], "Settled");
    assert.equal(finalBody.creditSettlement.refundedCredits, 15);
});

test("On-site Maintenance durations round up to half-hour increments", async () => {
    const roundedResponse = await fetch(`${baseUrl}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerId: "C-100",
            issue: "Maintenance duration rounds up",
            supportType: "On-site Support",
            onSiteSupportType: "Maintenance",
            appointmentTime: "09:00",
            appointmentDate: "2099-01-01",
            appointmentAddress: "100 Test Street",
            appointmentDuration: 1.2
        })
    });
    const roundedBody = await roundedResponse.json();

    assert.equal(roundedResponse.status, 201);

    let workbook = XLSX.readFile(databasePath);
    let tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);

    const roundedTicket = tickets.find(
        row => row["Issue"] === "Maintenance duration rounds up"
    );

    assert.ok(roundedTicket);
    assert.equal(Number(roundedTicket["Appointment Duration"]), 1.5);

    const exactResponse = await fetch(`${baseUrl}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerId: "C-100",
            issue: "Maintenance exact half hour",
            supportType: "On-site Support",
            onSiteSupportType: "Maintenance",
            appointmentTime: "10:00",
            appointmentDate: "2099-01-01",
            appointmentAddress: "100 Test Street",
            appointmentDuration: 1.5
        })
    });

    assert.equal(exactResponse.status, 201);

    workbook = XLSX.readFile(databasePath);
    tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);

    const exactTicket = tickets.find(
        row => row["Issue"] === "Maintenance exact half hour"
    );

    assert.ok(exactTicket);
    assert.equal(Number(exactTicket["Appointment Duration"]), 1.5);
});



test("Project report overages use available credits and flag unpaid remainder", async () => {
    const ticketId = await createOnSiteTicket("Project", 0, "00:00", "2099-01-01", "calendar", 2);
    let workbook = XLSX.readFile(databasePath);
    const appointment = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Ticket ID"] === ticketId);
    const customersBefore = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    customersBefore[0].Credits = 0;
    workbook.Sheets.Customer = XLSX.utils.json_to_sheet(customersBefore);
    XLSX.writeFile(workbook, databasePath);

    const response = await submitProjectSession(
        ticketId,
        appointment["Appointment ID"],
        "2099-01-01",
        "09:00",
        "04:12",
        true
    );
    const body = await response.json();
    workbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    const ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);

    assert.equal(response.status, 201);
    assert.equal(body.report["Billable Credits"], 19.5);
    assert.equal(customers[0].Credits, 0);
    assert.equal(ticket["Credits Charged"], 16);
    assert.equal(ticket["Unpaid Credits"], 3.5);
    assert.equal(ticket["Credit Settlement Status"], "Settled");
});

test("Project report overages charge available credits", async () => {
    const ticketId = await createOnSiteTicket(
        "Project",
        0,
        "00:00",
        "2099-01-01",
        "calendar",
        2
    );

    let workbook = XLSX.readFile(databasePath);
    const appointment = XLSX.utils.sheet_to_json(
        workbook.Sheets.Appointment
    ).find(row => row["Ticket ID"] === ticketId);

    const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);
    const ticket = tickets.find(row => row["Ticket ID"] === ticketId);

    // Force a low existing charge so the report creates an overage.
    ticket["Credits Charged"] = 1;
    ticket["Billable Credits"] = 1;
    workbook.Sheets.Ticket = XLSX.utils.json_to_sheet(tickets);
    XLSX.writeFile(workbook, databasePath);

    const response = await submitProjectSession(
        ticketId,
        appointment["Appointment ID"],
        "2099-01-01",
        "09:00",
        "10:12",
        true
    );
    const body = await response.json();

    workbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    const savedTicket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);

    assert.equal(response.status, 201);
    assert.equal(body.creditSettlement.additionalCredits, 0.5);
    assert.equal(customers[0].Credits, 3.5);
    assert.equal(savedTicket["Credits Charged"], 1.5);
    assert.equal(savedTicket["Unpaid Credits"], 0);
});


test("editing a completed Project report reconciles the customer balance", async () => {
    const ticketId = await createOnSiteTicket("Project", 0, "00:00", "2099-01-01", "calendar", 2);
    const appointment = XLSX.utils.sheet_to_json(
        XLSX.readFile(databasePath).Sheets.Appointment
    ).find(row => row["Ticket ID"] === ticketId);
    const initialResponse = await submitProjectSession(
        ticketId,
        appointment["Appointment ID"],
        "2099-01-01",
        "09:00",
        "09:12",
        true
    );
    assert.equal(initialResponse.status, 201);
    let workbook = XLSX.readFile(databasePath);
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Customer)[0].Credits, 19.5);

    const editResponse = await submitProjectSession(
        ticketId,
        appointment["Appointment ID"],
        "2099-01-01",
        "09:00",
        "10:00",
        true,
        "PUT"
    );
    const editBody = await editResponse.json();
    workbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    const ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);

    assert.equal(editResponse.status, 200);
    assert.equal(editBody.creditSettlement.additionalCredits, 0.5);
    assert.equal(customers[0].Credits, 19);
    assert.equal(ticket["Billable Credits"], 1);
    assert.equal(ticket["Credits Charged"], 1);
    assert.equal(ticket["Credit Settlement Status"], "Settled");
});

test("Project estimated-credit refunds wait until every Project appointment is complete", async () => {
    const ticketId = await createOnSiteTicket(
        "Project",
        0,
        "00:00",
        "2099-01-02",
        "weekdays",
        2
    );
    const cookie = await loginStaff();
    const secondAppointmentResponse = await fetch(
        `${baseUrl}/api/staff/tickets/${encodeURIComponent(ticketId)}/appointments`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Cookie: cookie
            },
            body: JSON.stringify({
                address: "Second Project visit",
                date: "2099-01-06",
                projectDays: 1,
                projectDayMode: "weekdays"
            })
        }
    );
    const secondAppointmentBody = await secondAppointmentResponse.json();
    assert.equal(secondAppointmentResponse.status, 201, secondAppointmentBody.message);
        console.log(
        XLSX.utils.sheet_to_json(
            XLSX.readFile(databasePath).Sheets.Appointment
        ).filter(row => row["Ticket ID"] === ticketId)
    );

    const firstAppointment = XLSX.utils.sheet_to_json(
        XLSX.readFile(databasePath).Sheets.Appointment
    ).find(row => row["Ticket ID"] === ticketId);

    const firstReportResponse = await submitProjectSession(
        ticketId,
        firstAppointment["Appointment ID"],
        "2099-01-02",
        "08:00",
        "08:30",
        true
    );
    assert.equal(firstReportResponse.status, 201);
    let workbook = XLSX.readFile(databasePath);
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Customer)[0].Credits, 4);
    let ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);
    assert.equal(ticket["Credits Charged"], 16);
    assert.equal(ticket["Billable Credits"], 0.5);
    assert.equal(ticket["Credit Settlement Status"], "Pending");

    const nextAppointments = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .filter(row => row["Ticket ID"] === ticketId);
    const secondAppointment = nextAppointments.find(
        row => row["Appointment ID"] !== firstAppointment["Appointment ID"]
    );

    console.log("FIRST APPOINTMENT:", firstAppointment);
    console.log("SECOND APPOINTMENT:", secondAppointment);

    console.log("APPOINTMENTS BEFORE SECOND REPORT:",
        XLSX.utils.sheet_to_json(
            XLSX.readFile(databasePath).Sheets.Appointment
        ).filter(row => row["Ticket ID"] === ticketId)
    );

    const appointmentsAfterCreation = XLSX.utils.sheet_to_json(
        XLSX.readFile(databasePath).Sheets.Appointment
    ).filter(row => row["Ticket ID"] === ticketId);

    console.log("APPOINTMENTS AFTER SECOND CREATION:");
    console.dir(appointmentsAfterCreation, { depth: null });


    const finalReportResponse = await submitProjectSession(
        ticketId,
        secondAppointment["Appointment ID"],
        "2099-01-06",
        "08:00",
        "08:30",
        true
    );

    const finalBody = await finalReportResponse.json();
    assert.equal(finalReportResponse.status, 201, finalBody.message);


    workbook = XLSX.readFile(databasePath);
    const finalCustomers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    ticket = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        .find(row => row["Ticket ID"] === ticketId);
    assert.equal(finalCustomers[0].Credits, 19);
    assert.equal(ticket["Credits Charged"], 1);
    assert.equal(ticket["Billable Credits"], 1);
    assert.equal(ticket["Credit Settlement Status"], "Settled");
});

test("legacy Project tickets with day-based durations remain exempt from credit deduction", async () => {
    const workbook = XLSX.readFile(databasePath);
    const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);
    tickets[0]["Support Type"] = "On-site Support";
    tickets[0]["On-site Support Type"] = "Project";
    tickets[0]["Appointment Duration"] = 3;
    delete tickets[0]["Project Estimated Hours"];
    workbook.Sheets.Ticket = XLSX.utils.json_to_sheet(tickets);
    XLSX.writeFile(workbook, databasePath);

    const response = await submitServiceReport("T-100", "09:00", "11:00");
    const body = await response.json();
    const savedWorkbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(savedWorkbook.Sheets.Customer);
    const ticket = XLSX.utils.sheet_to_json(savedWorkbook.Sheets.Ticket)[0];

    assert.equal(response.status, 201);
    assert.match(body.message, /Project tickets are exempt/);
    assert.equal(customers[0].Credits, 20);
    assert.equal(ticket["Credit Settlement Status"], "Exempt");
});

test("Project creation rejects insufficient estimated-hour credits without changing the balance", async () => {
    const response = await fetch(`${baseUrl}/api/tickets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            customerId: "C-100",
            issue: "Large Project",
            supportType: "On-site Support",
            onSiteSupportType: "Project",
            appointmentDate: "2099-01-01",
            appointmentAddress: "100 Test Street",
            projectDays: 3,
            projectDayMode: "calendar"
        })
    });
    const body = await response.json();
    const workbook = XLSX.readFile(databasePath);
    const customers = XLSX.utils.sheet_to_json(workbook.Sheets.Customer);
    const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);

    assert.equal(response.status, 400);
    assert.match(body.message, /only has 20 credit/);
    assert.equal(customers[0].Credits, 20);
    assert.equal(tickets.length, 1);
});

test("deleting an unfinished Project refunds only the unused estimate after actual work", async () => {
    const ticketId = await createOnSiteTicket("Project", 0, "00:00", "2099-01-01", "calendar", 2);
    let workbook = XLSX.readFile(databasePath);
    const appointment = XLSX.utils.sheet_to_json(workbook.Sheets.Appointment)
        .find(row => row["Ticket ID"] === ticketId);
    const reportResponse = await submitProjectSession(
        ticketId,
        appointment["Appointment ID"],
        "2099-01-01",
        "09:00",
        "10:00"
    );
    assert.equal(reportResponse.status, 201);

    const deleteResponse = await fetch(`${baseUrl}/api/tickets/${ticketId}`, {
        method: "DELETE",
        headers: { Cookie: await loginStaff() }
    });
    const deleteBody = await deleteResponse.json();
    workbook = XLSX.readFile(databasePath);

    assert.equal(deleteResponse.status, 200);
    assert.equal(deleteBody.refundApplied, true);
    assert.equal(deleteBody.refundedCredits, 15);
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Customer)[0].Credits, 19);
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
    assert.equal(customers[0].Credits, 19.5);
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
    assert.equal(customers[0].Credits, 19);
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
    assert.equal(customers[0].Credits, 18.5);
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
    assert.equal(customers[0].Credits, 18.5);
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
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Customer)[0].Credits, 20);

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
    assert.equal(XLSX.utils.sheet_to_json(workbook.Sheets.Customer)[0].Credits, 19);
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
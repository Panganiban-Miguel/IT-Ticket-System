const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, beforeEach, test } = require("node:test");

const databaseDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "it-ticket-login-tests-")
);
process.env.IT_TICKET_DATABASE_DIR = databaseDirectory;
process.env.IT_TICKET_LOGIN_RATE_LIMIT_MAX = "3";
process.env.IT_TICKET_LOGIN_RATE_LIMIT_WINDOW_MS = "100";

const XLSX = require("xlsx");
const app = require("../server");
delete process.env.IT_TICKET_DATABASE_DIR;
delete process.env.IT_TICKET_LOGIN_RATE_LIMIT_MAX;
delete process.env.IT_TICKET_LOGIN_RATE_LIMIT_WINDOW_MS;

const databasePath = path.join(databaseDirectory, "database.xlsx");
const staffCredentials = {
    email: "staff@example.test",
    password: "test-only-password"
};
const secondStaffCredentials = {
    email: "second-staff@example.test",
    password: "second-test-password"
};

let server;
let baseUrl;

function writeWorkbook() {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet([
            {
                "Staff ID": "S-100",
                Name: "Test Staff",
                Email: staffCredentials.email,
                Password: staffCredentials.password,
                Role: "Engineer",
                Department: "IT"
            },
            {
                "Staff ID": "S-200",
                Name: "Second Staff",
                Email: secondStaffCredentials.email,
                Password: secondStaffCredentials.password,
                Role: "Engineer",
                Department: "IT"
            }
        ]),
        "Staff"
    );
    XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.json_to_sheet([
            {
                "Ticket ID": "T-300",
                Issue: "Unassigned test ticket",
                Status: "Open",
                "Assigned Engineer": "",
                "Assigned Staff ID": ""
            },
            {
                "Ticket ID": "T-301",
                Issue: "Already assigned test ticket",
                Status: "Open",
                "Assigned Engineer": "Second Staff",
                "Assigned Staff ID": "S-200"
            }
        ]),
        "Ticket"
    );
    XLSX.writeFile(workbook, databasePath);
}

function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function login(email, password) {
    return fetch(`${baseUrl}/api/staff/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
    });
}

function sessionCookie(response) {
    return response.headers.get("set-cookie").split(";")[0];
}

async function updateProfile(cookie, profile) {
    return fetch(`${baseUrl}/api/staff/profile`, {
        method: "PATCH",
        headers: {
            "Content-Type": "application/json",
            Cookie: cookie
        },
        body: JSON.stringify(profile)
    });
}

before(async () => {
    writeWorkbook();
    server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => {
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

test("POST /api/staff/login accepts valid credentials", async () => {
    const response = await login(staffCredentials.email, staffCredentials.password);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.message, "Login successful.");
    assert.equal(body.staff.email, staffCredentials.email);
    assert.equal(Object.hasOwn(body.staff, "password"), false);
    assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
    assert.match(response.headers.get("set-cookie"), /SameSite=Lax/i);
});

test("POST /api/staff/login selects the account matching the submitted credentials", async () => {
    const response = await login(
        secondStaffCredentials.email,
        secondStaffCredentials.password
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.staff.staffId, "S-200");
    assert.equal(body.staff.name, "Second Staff");
    assert.equal(body.staff.email, secondStaffCredentials.email);
});

test("staff profile requires a session and updates only public profile fields", async () => {
    const unauthenticatedResponse = await fetch(`${baseUrl}/api/staff/profile`);
    assert.equal(unauthenticatedResponse.status, 401);

    const unauthenticatedUpdate = await fetch(`${baseUrl}/api/staff/profile`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Unauthorized Update" })
    });
    assert.equal(unauthenticatedUpdate.status, 401);

    const loginResponse = await login(staffCredentials.email, staffCredentials.password);
    const cookie = sessionCookie(loginResponse);
    const profileResponse = await fetch(`${baseUrl}/api/staff/profile`, {
        headers: { Cookie: cookie }
    });
    const profileBody = await profileResponse.json();

    assert.equal(profileResponse.status, 200);
    assert.equal(profileBody.staff.name, "Test Staff");
    assert.equal(Object.hasOwn(profileBody.staff, "password"), false);

    const updateResponse = await updateProfile(cookie, { name: "Updated Staff" });
    const updateBody = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.equal(updateBody.staff.name, "Updated Staff");
    assert.equal(Object.hasOwn(updateBody.staff, "password"), false);

    const workbook = XLSX.readFile(databasePath);
    const [staff] = XLSX.utils.sheet_to_json(workbook.Sheets.Staff);
    assert.equal(staff.Name, "Updated Staff");
    assert.equal(staff.Password, staffCredentials.password);
});

test("staff profile validates and hashes password changes", async () => {
    const loginResponse = await login(staffCredentials.email, staffCredentials.password);
    const cookie = sessionCookie(loginResponse);

    const mismatchResponse = await updateProfile(cookie, {
        name: "Test Staff",
        currentPassword: staffCredentials.password,
        newPassword: "new-test-password",
        confirmPassword: "different-test-password"
    });
    assert.equal(mismatchResponse.status, 400);

    const wrongCurrentResponse = await updateProfile(cookie, {
        name: "Test Staff",
        currentPassword: "incorrect-test-password",
        newPassword: "new-test-password",
        confirmPassword: "new-test-password"
    });
    assert.equal(wrongCurrentResponse.status, 403);

    const updateResponse = await updateProfile(cookie, {
        name: "Test Staff",
        currentPassword: staffCredentials.password,
        newPassword: "new-test-password",
        confirmPassword: "new-test-password"
    });
    const updateBody = await updateResponse.json();
    assert.equal(updateResponse.status, 200);
    assert.equal(Object.hasOwn(updateBody.staff, "password"), false);

    const workbook = XLSX.readFile(databasePath);
    const [staff] = XLSX.utils.sheet_to_json(workbook.Sheets.Staff);
    assert.match(staff.Password, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);

    const oldPasswordResponse = await login(staffCredentials.email, staffCredentials.password);
    const newPasswordResponse = await login(staffCredentials.email, "new-test-password");
    assert.equal(oldPasswordResponse.status, 401);
    assert.equal(newPasswordResponse.status, 200);
});

test("staff logout invalidates the session", async () => {
    const loginResponse = await login(staffCredentials.email, staffCredentials.password);
    const cookie = sessionCookie(loginResponse);
    const logoutResponse = await fetch(`${baseUrl}/api/staff/logout`, {
        method: "POST",
        headers: { Cookie: cookie }
    });

    assert.equal(logoutResponse.status, 204);

    const profileResponse = await fetch(`${baseUrl}/api/staff/profile`, {
        headers: { Cookie: cookie }
    });
    assert.equal(profileResponse.status, 401);
});

test("POST /api/staff/login limits attempts and allows retry after the window", async () => {
    await wait(120);

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await login(staffCredentials.email, "incorrect-test-password");
        assert.equal(response.status, 401);
    }

    const limitedResponse = await login(staffCredentials.email, "incorrect-test-password");
    const limitedBody = await limitedResponse.json();

    assert.equal(limitedResponse.status, 429);
    assert.equal(limitedBody.message, "Too many login attempts. Please try again later.");
    assert.ok(Number(limitedResponse.headers.get("retry-after")) > 0);

    await wait(120);
    const retryResponse = await login(staffCredentials.email, staffCredentials.password);
    assert.equal(retryResponse.status, 200);
});

test("staff directory is session-protected, imports login accounts, and retains independent staff records", async () => {
    const unauthorized = await fetch(`${baseUrl}/api/staff/directory`);
    assert.equal(unauthorized.status, 401);

    const loginResponse = await login(staffCredentials.email, staffCredentials.password);
    const cookie = sessionCookie(loginResponse);
    const directoryResponse = await fetch(`${baseUrl}/api/staff/directory`, {
        headers: { Cookie: cookie }
    });
    const directory = await directoryResponse.json();
    assert.equal(directoryResponse.status, 200);
    assert.equal(directory.staff.length, 2);
    assert.equal(directory.staff[0].loginStaffId, "S-100");
    assert.equal(Object.hasOwn(directory.staff[0], "password"), false);
    assert.equal(directory.loginAccounts.length, 2);

    const createResponse = await fetch(`${baseUrl}/api/staff/directory`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Cookie: cookie
        },
        body: JSON.stringify({
            name: "No Login Technician",
            role: "Technician",
            department: "Field Support",
            email: "technician@example.test",
            phone: "555-0100"
        })
    });
    const created = await createResponse.json();
    assert.equal(createResponse.status, 201);
    assert.equal(created.staff.loginStaffId, "");

    const deactivateResponse = await fetch(
        `${baseUrl}/api/staff/directory/${encodeURIComponent(created.staff.staffId)}`,
        {
            method: "PATCH",
            headers: {
                "Content-Type": "application/json",
                Cookie: cookie
            },
            body: JSON.stringify({ active: false })
        }
    );
    assert.equal(deactivateResponse.status, 200);

    const savedWorkbook = XLSX.readFile(databasePath);
    const roster = XLSX.utils.sheet_to_json(savedWorkbook.Sheets.StaffRoster);
    const inactive = roster.find(person => person["Staff ID"] === created.staff.staffId);
    assert.equal(inactive.Active, "No");
});

test("staff can assign an unassigned ticket to an active staff record", async () => {
    const unauthorized = await fetch(`${baseUrl}/api/staff/tickets/T-300/assignment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ staffId: "S-200" })
    });
    assert.equal(unauthorized.status, 401);

    const cookie = sessionCookie(await login(staffCredentials.email, staffCredentials.password));
    const directoryResponse = await fetch(`${baseUrl}/api/staff/directory`, {
        headers: { Cookie: cookie }
    });
    const directory = await directoryResponse.json();
    assert.deepEqual(directory.unassignedTickets.map(ticket => ticket.ticketId), ["T-300"]);

    const assignmentResponse = await fetch(`${baseUrl}/api/staff/tickets/T-300/assignment`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Cookie: cookie
        },
        body: JSON.stringify({ staffId: "S-200" })
    });
    assert.equal(assignmentResponse.status, 200);

    const workbook = XLSX.readFile(databasePath);
    const tickets = XLSX.utils.sheet_to_json(workbook.Sheets.Ticket);
    const assignedTicket = tickets.find(ticket => ticket["Ticket ID"] === "T-300");
    assert.equal(assignedTicket["Assigned Staff ID"], "S-200");
    assert.equal(assignedTicket["Assigned Engineer"], "Second Staff");

    const duplicateResponse = await fetch(`${baseUrl}/api/staff/tickets/T-300/assignment`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Cookie: cookie
        },
        body: JSON.stringify({ staffId: "S-100" })
    });
    assert.equal(duplicateResponse.status, 409);
});

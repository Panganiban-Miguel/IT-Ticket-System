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

let server;
let baseUrl;

function writeWorkbook() {
    const workbook = XLSX.utils.book_new();
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

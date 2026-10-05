const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const countTicketStatuses = require("../public/ticket-metrics");
const filterTicketsByStatus = countTicketStatuses.filterTicketsByStatus;

test("counts total and recognized ticket statuses in one pass", () => {
    const tickets = [
        { Status: "Open" },
        { Status: "In Progress" },
        { Status: "Pending" },
        { Status: "Closed" },
        { Status: "Open" },
        { Status: "Unknown" }
    ];

    assert.deepEqual(countTicketStatuses(tickets), {
        total: 6,
        open: 2,
        inProgress: 2,
        closed: 1
    });
});

test("filters tickets by status without excluding pending from the combined group", () => {
    const tickets = [
        { Status: "Open" },
        { Status: "In Progress" },
        { Status: "Pending" },
        { Status: "Closed" },
        { Status: "Unknown" }
    ];

    assert.deepEqual(filterTicketsByStatus(tickets, "all"), tickets);
    assert.deepEqual(filterTicketsByStatus(tickets, "open"), [{ Status: "Open" }]);
    assert.deepEqual(filterTicketsByStatus(tickets, "inProgressPending"), [
        { Status: "In Progress" },
        { Status: "Pending" }
    ]);
    assert.deepEqual(filterTicketsByStatus(tickets, "closed"), [{ Status: "Closed" }]);
    assert.deepEqual(filterTicketsByStatus([{ Status: "Open" }], "closed"), []);
});

test("returns zero status totals for an empty ticket list", () => {
    assert.deepEqual(countTicketStatuses([]), {
        total: 0,
        open: 0,
        inProgress: 0,
        closed: 0
    });
    assert.deepEqual(filterTicketsByStatus([], "inProgressPending"), []);
});

test("iterates over the ticket list exactly once", () => {
    let iterationCount = 0;
    const tickets = {
        length: 2,
        *[Symbol.iterator]() {
            iterationCount += 1;
            yield { Status: "Open" };
            yield { Status: "Closed" };
        }
    };

    assert.deepEqual(countTicketStatuses(tickets), {
        total: 2,
        open: 1,
        inProgress: 0,
        closed: 1
    });
    assert.equal(iterationCount, 1);
});

test("exposes the counter to the staff page before the dashboard script", () => {
    const helperPath = path.join(__dirname, "../public/ticket-metrics.js");
    const staffPagePath = path.join(__dirname, "../public/staff.html");
    const browserContext = vm.createContext({});
    vm.runInContext(fs.readFileSync(helperPath, "utf8"), browserContext);

    const browserCounts = browserContext.countTicketStatuses([
        { Status: "Open" },
        { Status: "Closed" }
    ]);
    const staffPage = fs.readFileSync(staffPagePath, "utf8");
    const helperScriptPosition = staffPage.indexOf('/ticket-metrics.js');
    const dashboardScriptPosition = staffPage.indexOf('/script.js');

    assert.deepEqual(JSON.parse(JSON.stringify(browserCounts)), {
        total: 2,
        open: 1,
        inProgress: 0,
        closed: 1
    });
    assert.deepEqual(
        JSON.parse(JSON.stringify(browserContext.filterTicketsByStatus([
            { Status: "In Progress" },
            { Status: "Pending" },
            { Status: "Closed" }
        ], "inProgressPending"))),
        [{ Status: "In Progress" }, { Status: "Pending" }]
    );
    assert.notEqual(helperScriptPosition, -1);
    assert.ok(helperScriptPosition < dashboardScriptPosition);
});
const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
    chooseTechnician,
    getAppointmentCandidate,
    hasSchedulingConflict
} = require("../scheduler");

function scheduledAppointment({
    staffId = "S-1",
    startDate = "2099-06-01",
    startTime = "09:00",
    endDate = startDate,
    endTime = "10:00",
    status = "Pending",
    projectDays = 0,
    projectDayMode = ""
} = {}) {
    return {
        "Appointment ID": `A-${Math.random()}`,
        "Ticket ID": "T-1",
        "Staff ID": staffId,
        "Start Date": startDate,
        "Start Time": startTime,
        "End Date": endDate,
        "End Time": endTime,
        "Actual End Date": "",
        "Actual End Time": "",
        "Project Days": projectDays,
        "Project Day Mode": projectDayMode,
        Status: status
    };
}

test("travel buffer rejects bookings with less than one hour gap and permits the exact boundary", () => {
    const previous = scheduledAppointment();
    const conflict = getAppointmentCandidate({
        date: "2099-06-01",
        time: "10:59",
        durationHours: 1,
        address: "Visit address"
    });
    const boundary = getAppointmentCandidate({
        date: "2099-06-01",
        time: "11:00",
        durationHours: 1,
        address: "Visit address"
    });

    assert.equal(hasSchedulingConflict({ ...conflict, "Staff ID": "S-1" }, [previous]), true);
    assert.equal(hasSchedulingConflict({ ...boundary, "Staff ID": "S-1" }, [previous]), false);
});

test("completed appointment reserves only actual service time and its travel buffer", () => {
    const completed = {
        ...scheduledAppointment({ status: "Completed", endTime: "13:00" }),
        "Actual End Date": "2099-06-01",
        "Actual End Time": "11:30"
    };
    const earlySlot = getAppointmentCandidate({
        date: "2099-06-01",
        time: "12:30",
        durationHours: 1,
        address: "Second address"
    });
    const availableSlot = getAppointmentCandidate({
        date: "2099-06-01",
        time: "12:30",
        durationHours: 1,
        address: "Second address"
    });

    assert.equal(hasSchedulingConflict({ ...earlySlot, "Staff ID": "S-1" }, [completed]), false);
    completed["Actual End Time"] = "11:45";
    assert.equal(hasSchedulingConflict({ ...availableSlot, "Staff ID": "S-1" }, [completed]), true);
});

test("project reservations support calendar-day and weekday-only spans", () => {
    const calendarProject = {
        ...getAppointmentCandidate({
        date: "2099-01-02",
        time: "09:00",
        projectDays: 2,
        projectDayMode: "calendar",
        address: "Project address"
        }),
        "Staff ID": "S-1"
    };
    const weekdayProject = {
        ...getAppointmentCandidate({
        date: "2099-01-02",
        time: "09:00",
        projectDays: 2,
        projectDayMode: "weekdays",
        address: "Project address"
        }),
        "Staff ID": "S-1"
    };
    const saturdayVisit = {
        ...getAppointmentCandidate({
            date: "2099-01-03",
            time: "12:00",
            durationHours: 1,
            address: "Weekend address"
        }),
        "Staff ID": "S-1"
    };

    assert.equal(hasSchedulingConflict({ ...saturdayVisit, "Staff ID": "S-1" }, [calendarProject]), true);
    assert.equal(hasSchedulingConflict({ ...saturdayVisit, "Staff ID": "S-1" }, [weekdayProject]), false);
});

test("automatic assignment chooses the eligible available technician with least scheduled hours", () => {
    const staff = [
        { "Staff ID": "S-1", Name: "Alex", Role: "Engineer", Active: "Yes" },
        { "Staff ID": "S-2", Name: "Bailey", Role: "Technician", Active: "Yes" },
        { "Staff ID": "S-3", Name: "Inactive", Role: "Engineer", Active: "No" },
        { "Staff ID": "S-4", Name: "Other Role", Role: "Manager", Active: "Yes" }
    ];
    const existing = [scheduledAppointment({ staffId: "S-1", startTime: "08:00", endTime: "10:00" })];
    const candidate = getAppointmentCandidate({
        date: "2099-06-01",
        time: "12:00",
        durationHours: 1,
        address: "Visit address"
    });

    assert.equal(chooseTechnician(staff, existing, candidate, ["Engineer", "Technician"])["Staff ID"], "S-2");
});

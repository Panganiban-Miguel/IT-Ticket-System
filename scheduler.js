const TRAVEL_BUFFER_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const SCHEDULING_STATUSES = new Set(["Pending", "Confirmed", "Completed"]);

function localDateTime(date, time) {
    const [year, month, day] = String(date).split("-").map(Number);
    const [hours, minutes] = String(time).split(":").map(Number);

    if (![year, month, day, hours, minutes].every(Number.isInteger)) {
        return NaN;
    }

    const result = new Date(year, month - 1, day, hours, minutes, 0, 0);
    if (
        result.getFullYear() !== year ||
        result.getMonth() !== month - 1 ||
        result.getDate() !== day ||
        result.getHours() !== hours ||
        result.getMinutes() !== minutes
    ) {
        return NaN;
    }

    return result.getTime();
}

function dateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function addDays(date, days) {
    const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    result.setDate(result.getDate() + days);
    return result;
}

function projectReservationDates(appointment) {
    const projectDays = Number(appointment["Project Days"] || 0);
    const startDate = String(appointment["Start Date"] || "");
    const firstDay = new Date(`${startDate}T00:00:00`);
    if (!Number.isInteger(projectDays) || projectDays < 1 || Number.isNaN(firstDay.getTime())) {
        return [];
    }
    const mode = String(appointment["Project Day Mode"] || "calendar");
    const dates = [];
    let current = firstDay;
    while (dates.length < projectDays) {
        const weekday = current.getDay();
        if (mode !== "weekdays" || (weekday !== 0 && weekday !== 6)) {
            dates.push(dateString(current));
        }
        if (dates.length < projectDays) {
            current = addDays(current, 1);
        }
    }
    return dates;
}

function appointmentInterval(appointment, useActualEnd = true) {
    const projectDays = Number(appointment["Project Days"] || 0);

    if (projectDays > 0) {
        const startDate = String(appointment["Start Date"] || "");
        const mode = String(appointment["Project Day Mode"] || "calendar");
        const firstDay = new Date(`${startDate}T00:00:00`);
        if (Number.isNaN(firstDay.getTime())) {
            return null;
        }

        const endDay = new Date(firstDay);
        let includedDays = 0;
        while (includedDays < projectDays) {
            const weekday = endDay.getDay();
            if (mode !== "weekdays" || (weekday !== 0 && weekday !== 6)) {
                includedDays += 1;
            }
            if (includedDays < projectDays) {
                endDay.setDate(endDay.getDate() + 1);
            }
        }

        const actualEnd = useActualEnd
            ? localDateTime(appointment["Actual End Date"], appointment["Actual End Time"])
            : NaN;
        const actualStart = useActualEnd
            ? localDateTime(appointment["Actual Start Date"], appointment["Actual Start Time"])
            : NaN;
        return {
            start: Number.isFinite(actualStart)
                ? actualStart
                : new Date(`${startDate}T00:00:00`).getTime(),
            end: Number.isFinite(actualEnd) ? actualEnd : addDays(endDay, 1).getTime(),
            fullDayProject: true
        };
    }

    const start = localDateTime(appointment["Start Date"], appointment["Start Time"]);
    const actualStart = useActualEnd
        ? localDateTime(appointment["Actual Start Date"], appointment["Actual Start Time"])
        : NaN;
    const actualEnd = useActualEnd
        ? localDateTime(appointment["Actual End Date"], appointment["Actual End Time"])
        : NaN;
    const plannedEnd = localDateTime(appointment["End Date"], appointment["End Time"]);
    const end = Number.isFinite(actualEnd) ? actualEnd : plannedEnd;

    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        return null;
    }

    return {
        start: Number.isFinite(actualStart) ? actualStart : start,
        end,
        fullDayProject: false
    };
}

function appointmentIntervals(appointment, useActualEnd = true) {
    const projectDays = Number(appointment["Project Days"] || 0);
    if (projectDays <= 0) {
        const interval = appointmentInterval(appointment, useActualEnd);
        return interval ? [interval] : [];
    }

    const startDate = String(appointment["Start Date"] || "");
    const firstDay = new Date(`${startDate}T00:00:00`);
    if (Number.isNaN(firstDay.getTime())) {
        return [];
    }
    const actualEnd = useActualEnd
        ? localDateTime(appointment["Actual End Date"], appointment["Actual End Time"])
        : NaN;
    let serviceSessions = [];
    try {
        serviceSessions = JSON.parse(String(appointment["Service Sessions"] || "[]"));
    } catch {
        serviceSessions = [];
    }
    if (!Array.isArray(serviceSessions)) {
        serviceSessions = [];
    }
    const sessionIntervals = Array.isArray(serviceSessions)
        ? serviceSessions.map(session => ({
            start: localDateTime(session.date, session.signInTime),
            end: localDateTime(session.endDate || session.date, session.signOutTime),
            fullDayProject: false
        })).filter(interval =>
            Number.isFinite(interval.start) &&
            Number.isFinite(interval.end) &&
            interval.end > interval.start
        )
        : [];
    if (
        String(appointment["Project Complete"] || "").toLowerCase() === "yes" ||
        (String(appointment.Status || "") === "Completed" && Number.isFinite(actualEnd))
    ) {
        if (sessionIntervals.length) {
            return sessionIntervals;
        }
        const actualStart = localDateTime(
            appointment["Actual Start Date"],
            appointment["Actual Start Time"]
        );
        return Number.isFinite(actualEnd) && Number.isFinite(actualStart)
            ? [{ start: actualStart, end: actualEnd, fullDayProject: false }]
            : [];
    }

    const intervals = [];
    const submittedSessionDates = new Set(
        serviceSessions.map(session => String(session.date || ""))
    );
    intervals.push(...sessionIntervals);
    projectReservationDates(appointment)
        .filter(date => !submittedSessionDates.has(date))
        .forEach(date => {
            const day = new Date(`${date}T00:00:00`);
            intervals.push({
                start: day.getTime(),
                end: addDays(day, 1).getTime(),
                fullDayProject: true
            });
        });
    return intervals;
}

function hasSchedulingConflict(candidate, existingAppointments) {
    const candidateIntervals = appointmentIntervals(candidate, false);
    if (!candidateIntervals.length) {
        return true;
    }

    return existingAppointments.some(appointment => {
        if (
            String(appointment["Staff ID"] || "") !== String(candidate["Staff ID"] || "") ||
            !SCHEDULING_STATUSES.has(String(appointment.Status || ""))
        ) {
            return false;
        }

        const existingIntervals = appointmentIntervals(appointment, true);
        if (!existingIntervals.length) {
            return false;
        }
        return candidateIntervals.some(candidateInterval =>
            existingIntervals.some(existingInterval => {
                const travelBuffer =
                    candidateInterval.fullDayProject || existingInterval.fullDayProject
                        ? 0
                        : TRAVEL_BUFFER_MS;

                return candidateInterval.start < existingInterval.end + travelBuffer &&
                    existingInterval.start < candidateInterval.end + travelBuffer;
            })
        );
    });
}

function chooseTechnician(staff, appointments, candidate, roles) {
    const eligibleRoles = new Set(roles.map(role => String(role).trim().toLowerCase()));
    const eligible = staff
        .filter(person =>
            String(person["Active"] ?? "Yes").toLowerCase() !== "no" &&
            eligibleRoles.has(String(person.Role || "").trim().toLowerCase())
        )
        .filter(person => !hasSchedulingConflict(
            { ...candidate, "Staff ID": person["Staff ID"] },
            appointments
        ))
        .map(person => {
            const assignedMs = appointments.reduce((total, appointment) => {
                if (
                    String(appointment["Staff ID"] || "") !== String(person["Staff ID"] || "") ||
                    String(appointment["Start Date"] || "") !== String(candidate["Start Date"] || "") ||
                    !SCHEDULING_STATUSES.has(String(appointment.Status || ""))
                ) {
                    return total;
                }
                const intervals = appointmentIntervals(appointment, true);
                return total + intervals.reduce(
                    (duration, interval) => duration + interval.end - interval.start,
                    0
                );
            }, 0);
            return { person, assignedMs };
        })
        .sort((left, right) =>
            left.assignedMs - right.assignedMs ||
            String(left.person.Name || "").localeCompare(String(right.person.Name || ""))
        );

    return eligible.length ? eligible[0].person : null;
}

function getEndDateTime(date, time, durationHours) {
    const start = localDateTime(date, time);
    if (!Number.isFinite(start) || !Number.isFinite(durationHours) || durationHours <= 0) {
        return null;
    }
    const end = new Date(start + durationHours * 60 * MINUTE_MS);
    return {
        date: dateString(end),
        time: `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`
    };
}

function getAppointmentCandidate({ date, time, durationHours, projectDays, projectDayMode, address, ticketId }) {
    if (Number(projectDays) > 0) {
        return {
            "Ticket ID": ticketId || "",
            "Start Date": date,
            "Start Time": "00:00",
            "End Date": date,
            "End Time": "23:59",
            "Project Days": Number(projectDays),
            "Project Day Mode": projectDayMode,
            Address: address || "",
            Status: "Pending"
        };
    }

    const end = getEndDateTime(date, time, Number(durationHours));
    if (!end) {
        return null;
    }
    return {
        "Ticket ID": ticketId || "",
        "Start Date": date,
        "Start Time": time,
        "End Date": end.date,
        "End Time": end.time,
        "Project Days": 0,
        "Project Day Mode": "",
        Address: address || "",
        Status: "Pending"
    };
}

module.exports = {
    MINUTE_MS,
    TRAVEL_BUFFER_MS,
    appointmentInterval,
    chooseTechnician,
    getAppointmentCandidate,
    getEndDateTime,
    hasSchedulingConflict,
    localDateTime,
    projectReservationDates
};

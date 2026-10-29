const express = require("express");
const { rateLimit } = require("express-rate-limit");
const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const {
    appointmentInterval,
    chooseTechnician,
    getAppointmentCandidate,
    hasSchedulingConflict,
    localDateTime,
    projectReservationDates
} = require("./scheduler");

const app = express();
const PORT = process.env.PORT || 3000;
const configuredLoginRateLimit = Number.parseInt(process.env.IT_TICKET_LOGIN_RATE_LIMIT_MAX, 10);
const configuredLoginRateLimitWindowMs = Number.parseInt(
    process.env.IT_TICKET_LOGIN_RATE_LIMIT_WINDOW_MS,
    10
);
const loginRateLimiter = rateLimit({
    windowMs: Number.isInteger(configuredLoginRateLimitWindowMs) && configuredLoginRateLimitWindowMs > 0
        ? configuredLoginRateLimitWindowMs
        : 15 * 60 * 1000,
    limit: Number.isInteger(configuredLoginRateLimit) && configuredLoginRateLimit > 0
        ? configuredLoginRateLimit
        : 5,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({
        message: "Too many login attempts. Please try again later."
    })
});

const excelDir = process.env.IT_TICKET_DATABASE_DIR || path.join(
    __dirname,
    "Database"
);

const excelFile = path.join(
    excelDir,
    "database.xlsx"
);

const lockFile = path.join(
    excelDir,
    "database.xlsx.lock"
);

const LOCK_TIMEOUT_MS = 30000;
const STAFF_SESSION_COOKIE = "it_staff_session";
const STAFF_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const staffSessions = new Map();

function hashStaffPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyStaffPassword(password, storedPassword) {
    const storedValue = String(storedPassword || "");
    const parts = storedValue.split(":");

    if (
        parts.length === 3 &&
        parts[0] === "scrypt" &&
        /^[0-9a-f]{32}$/i.test(parts[1]) &&
        /^[0-9a-f]{128}$/i.test(parts[2])
    ) {
        const expectedHash = Buffer.from(parts[2], "hex");
        const actualHash = crypto.scryptSync(
            String(password),
            Buffer.from(parts[1], "hex"),
            expectedHash.length
        );
        return crypto.timingSafeEqual(actualHash, expectedHash);
    }

    const enteredBuffer = Buffer.from(String(password));
    const storedBuffer = Buffer.from(storedValue);
    return enteredBuffer.length === storedBuffer.length &&
        crypto.timingSafeEqual(enteredBuffer, storedBuffer);
}

function staffProfile(staff) {
    return {
        staffId: staff["Staff ID"],
        name: staff.Name,
        email: staff.Email,
        role: staff.Role,
        department: staff.Department
    };
}

function getStaffSessionToken(req) {
    const cookieHeader = req.headers.cookie || "";
    const cookie = cookieHeader
        .split(";")
        .map(value => value.trim())
        .find(value => value.startsWith(`${STAFF_SESSION_COOKIE}=`));

    return cookie ? cookie.slice(STAFF_SESSION_COOKIE.length + 1) : "";
}

function setStaffSessionCookie(req, res, token, maxAgeSeconds) {
    const cookieParts = [
        `${STAFF_SESSION_COOKIE}=${token}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        `Max-Age=${maxAgeSeconds}`
    ];

    if (req.secure || process.env.NODE_ENV === "production") {
        cookieParts.push("Secure");
    }

    res.setHeader("Set-Cookie", cookieParts.join("; "));
}

function requireStaffSession(req, res, next) {
    const token = getStaffSessionToken(req);
    const session = staffSessions.get(token);

    if (!session || session.expiresAt <= Date.now()) {
        staffSessions.delete(token);
        return res.status(401).json({ message: "Please log in to continue." });
    }

    req.staffSession = session;
    next();
}

function findStaffForSession(staffData, session) {
    return staffData.find(staff => {
        const staffId = String(staff["Staff ID"] || "");
        const staffEmail = String(staff.Email || "").trim().toLowerCase();

        if (session.staffId) {
            return staffId === session.staffId && staffEmail === session.email;
        }

        return staffEmail === session.email;
    });
}

function acquireWorkbookLock() {
    try {
        if (fs.existsSync(lockFile)) {
            const lockInfo = fs.readFileSync(lockFile, "utf8");
            const lockAge = Date.now() - fs.statSync(lockFile).mtimeMs;

            if (lockAge > LOCK_TIMEOUT_MS) {
                fs.unlinkSync(lockFile);
            } else {
                const lockError = new Error(
                    "Another save is already in progress. Please wait a moment and try again."
                );
                lockError.code = "DATABASE_LOCKED";
                throw lockError;
            }
        }

        fs.writeFileSync(
            lockFile,
            JSON.stringify({
                pid: process.pid,
                timestamp: Date.now()
            }),
            { flag: "wx" }
        );

    } catch (error) {
        if (error && error.code === "EEXIST") {
            const lockError = new Error(
                "Another save is already in progress. Please wait a moment and try again."
            );
            lockError.code = "DATABASE_LOCKED";
            throw lockError;
        }

        if (error && error.code === "DATABASE_LOCKED") {
            throw error;
        }

        throw error;
    }
}

function releaseWorkbookLock() {
    try {
        if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
        }
    } catch (_) {}
}

function writeWorkbook(workbook, beforeWrite) {
    acquireWorkbookLock();

    const tempWorkbookPath = path.join(
        excelDir,
        `database-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp.xlsx`
    );

    try {
        if (beforeWrite) {
            beforeWrite();
        }
        XLSX.writeFile(workbook, tempWorkbookPath);

        try {
            fs.copyFileSync(tempWorkbookPath, excelFile);
        } catch (error) {
            const message = String(error && error.message ? error.message : error);
            const isLocked =
                error && (
                    error.code === "EACCES" ||
                    error.code === "EPERM" ||
                    /locked|permission|access/i.test(message)
                );

            if (isLocked) {
                const lockError = new Error(
                    "The Excel database is currently locked. Please close the workbook in Excel and try again."
                );
                lockError.code = "DATABASE_LOCKED";
                throw lockError;
            }

            throw error;
        }
    } finally {
        try {
            if (fs.existsSync(tempWorkbookPath)) {
                fs.unlinkSync(tempWorkbookPath);
            }
        } catch (_) {}

        releaseWorkbookLock();
    }

    return true;
}


function validateAppointmentBusinessHours(appointmentTime, durationHours) {
    // Validate that a time was provided
    if (!appointmentTime) {
        return "Please select an appointment time.";
    }

    // Validate duration
    if (
        typeof durationHours !== "number" ||
        !Number.isFinite(durationHours) ||
        durationHours <= 0 ||
        durationHours % 0.5 !== 0
    ) {
        return "Please select a valid appointment duration.";
    }

    // Parse HH:MM
    const [hours, minutes] = appointmentTime.split(":").map(Number);

    if (
        !Number.isInteger(hours) ||
        !Number.isInteger(minutes) ||
        hours < 0 ||
        hours > 23 ||
        minutes < 0 ||
        minutes > 59
    ) {
        return "Please select a valid appointment time.";
    }

    const startMinutes = hours * 60 + minutes;
    const endMinutes = startMinutes + durationHours * 60;

    const openingMinutes = 9 * 60;  // 9:00 AM
    const closingMinutes = 18 * 60; // 6:00 PM

    // Starts before business hours
    if (startMinutes < openingMinutes) {
        return "This appointment starts before 9:00 AM. Please select a different time, or consider scheduling this as a project instead.";
    }

    // Starts at or after closing
    if (startMinutes >= closingMinutes) {
        return "This appointment starts at or after 6:00 PM. Please select a different time, or consider scheduling this as a project instead.";
    }

    // Ends after closing
    if (endMinutes > closingMinutes) {
        return "This appointment would extend past 6:00 PM. Please select a different time, or consider scheduling this as a project instead.";
    }

    // Valid
    return null;
}



function validateAppointmentDateTime(appointmentDate, appointmentTime, now = new Date()) {
    if (!appointmentDate || !appointmentTime) {
        return "Please select both an appointment date and time.";
    }

    const selectedDateTime = new Date(`${appointmentDate}T${appointmentTime}:00`);

    if (Number.isNaN(selectedDateTime.getTime())) {
        return "Please select a valid appointment date and time.";
    }

    const currentDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const selectedDate = new Date(
        selectedDateTime.getFullYear(),
        selectedDateTime.getMonth(),
        selectedDateTime.getDate()
    );

    if (selectedDate < currentDate) {
        return "Appointment date cannot be before today.";
    }

    if (selectedDateTime < now) {
        return "Appointment time cannot be before the current time.";
    }

    const sameDay = selectedDate.getTime() === currentDate.getTime();

    if (sameDay) {
        const minimumAllowedStart = new Date(now.getTime() + (1 * 60 * 60 * 1000));

        if (selectedDateTime < minimumAllowedStart) {
            return "Appointment must be at least 1 hour after the current time for same-day bookings.";
        }
    }

    return null;
}

function validateProjectBookingDate(appointmentDate, now = new Date()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(appointmentDate || ""))) {
        return "Please select a valid Project start date.";
    }
    const selectedTimestamp = localDateTime(appointmentDate, "00:00");
    if (!Number.isFinite(selectedTimestamp)) {
        return "Please select a valid Project start date.";
    }
    const selectedDate = new Date(selectedTimestamp);
    const currentDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (selectedDate <= currentDate) {
        return "A multi-day Project reservation must start on a future date.";
    }
    return null;
}

function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
}

function validateOptionalText(value, fieldName, maxLength) {
    if (value === undefined || value === null) {
        return null;
    }

    if (typeof value !== "string") {
        return `${fieldName} must be text.`;
    }

    if (value.length > maxLength) {
        return `${fieldName} must be ${maxLength} characters or fewer.`;
    }

    return null;
}

function validateTicketCreation(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return "Request body must be a JSON object.";
    }

    const supportTypes = [
        "Phone Support",
        "Email Support",
        "Remote Support",
        "On-site Support"
    ];
    const textFields = [
        ["customerName", "Customer name", 120],
        ["email", "Email", 254],
        ["customerId", "Customer ID", 64],
        ["issue", "Issue", 5000],
        ["supportType", "Support type", 40],
        ["onSiteSupportType", "On-site support type", 20],
        ["appointmentDate", "Appointment date", 10],
        ["appointmentTime", "Appointment time", 5],
        ["appointmentAddress", "Appointment address", 500],
        ["projectDayMode", "Project day mode", 20]
    ];

    for (const [field, label, maxLength] of textFields) {
        const validationMessage = validateOptionalText(body[field], label, maxLength);
        if (validationMessage) {
            return validationMessage;
        }
    }

    if (!body.issue || !body.issue.trim() || !body.supportType || !body.supportType.trim()) {
        return "Please provide an issue and support type.";
    }

    if (!body.customerId && !body.email) {
        return "Please provide a customer ID or email.";
    }

    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email.trim())) {
        return "Please provide a valid email address.";
    }

    if (!supportTypes.includes(body.supportType.trim())) {
        return "Please select a valid support type.";
    }

    if (
        body.supportType.trim() === "On-site Support" &&
        (!body.appointmentAddress || !body.appointmentAddress.trim())
    ) {
        return "Please provide the on-site appointment address.";
    }

    if (
        body.supportType.trim() === "On-site Support" &&
        body.onSiteSupportType === "Project" &&
        body.projectDayMode !== undefined &&
        body.projectDayMode !== "" &&
        !["calendar", "weekdays"].includes(body.projectDayMode)
    ) {
        return "Please choose calendar days or weekdays for the Project booking.";
    }

    for (const [field, label] of [
        ["appointmentDuration", "Appointment duration"],
        ["projectDays", "Project days"],
//        ["projectEstimatedHours", "Project estimated hours"]
    ]) {
        if (
            body[field] !== undefined &&
            body[field] !== null &&
            typeof body[field] !== "string" &&
            typeof body[field] !== "number"
        ) {
            return `${label} must be a number.`;
        }
        if (
            body[field] !== undefined &&
            body[field] !== null &&
            String(body[field]).trim() !== "" &&
            !Number.isFinite(Number(body[field]))
        ) {
            return `${label} must be a valid number.`;
        }
    }

    return null;
}

function validateTicketUpdate(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return "Request body must be a JSON object.";
    }

    const textFields = [
        ["assignedEngineer", "Assigned engineer", 120],
        ["serviceResult", "Service result", 5000],
        ["customerName", "Customer name", 120],
        ["email", "Email", 254],
        ["customerId", "Customer ID", 64]
    ];

    for (const [field, label, maxLength] of textFields) {
        const validationMessage = validateOptionalText(body[field], label, maxLength);
        if (validationMessage) {
            return validationMessage;
        }
    }

    if (body.status !== undefined && !["Open", "In Progress", "Pending", "Closed"].includes(body.status)) {
        return "Please select a valid ticket status.";
    }

    if (
        body.appointmentStatus !== undefined &&
        body.appointmentStatus !== "" &&
        !["Pending", "Confirmed", "Reschedule Required"].includes(body.appointmentStatus)
    ) {
        return "Please select a valid appointment status.";
    }

    return null;
}

function validateServiceReport(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        return "Request body must be a JSON object.";
    }

    const textFields = [
        ["appointmentId", "Appointment ID", 100],
        ["engineer", "Engineer", 120],
        ["tasksDone", "Tasks done", 5000],
        ["resolution", "Resolution", 5000],
        ["serviceMode", "Service mode", 30],
        ["date", "Service date", 10],
        ["signInTime", "Sign-in time", 5],
        ["signOutTime", "Sign-out time", 5]
    ];

    for (const [field, label, maxLength] of textFields) {
        const validationMessage = validateOptionalText(body[field], label, maxLength);
        if (validationMessage) {
            return validationMessage;
        }
    }

    if (body.projectComplete !== undefined && typeof body.projectComplete !== "boolean") {
        return "Project completion must be a boolean.";
    }

    if (
        body.serviceMode !== undefined &&
        body.serviceMode !== "" &&
        ![
            "on-site",
            "onsite",
            "on site",
            "yes",
            "visit",
            "on-site visit",
            "remote",
            "remote support",
            "off-site",
            "offsite",
            "no",
            "hybrid",
            "hybrid support"
        ].includes(body.serviceMode.trim().toLowerCase())
    ) {
        return "Please select a valid service mode.";
    }

    if (body.date !== undefined && body.date !== "") {
        const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(body.date);
        if (!dateMatch) {
            return "Please provide a valid service date.";
        }

        const date = new Date(Date.UTC(
            Number(dateMatch[1]),
            Number(dateMatch[2]) - 1,
            Number(dateMatch[3])
        ));
        if (
            date.getUTCFullYear() !== Number(dateMatch[1]) ||
            date.getUTCMonth() !== Number(dateMatch[2]) - 1 ||
            date.getUTCDate() !== Number(dateMatch[3])
        ) {
            return "Please provide a valid service date.";
        }
    }

    for (const [field, label] of [["signInTime", "Sign-in time"], ["signOutTime", "Sign-out time"]]) {
        if (body[field] !== undefined && body[field] !== "" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(body[field])) {
            return `${label} must use HH:MM format.`;
        }
    }

    if (body.onsite !== undefined && typeof body.onsite !== "boolean") {
        const legacyOnsiteValues = [
            "on-site",
            "onsite",
            "on site",
            "yes",
            "visit",
            "on-site visit",
            "remote",
            "remote support",
            "off-site",
            "offsite",
            "no",
            "hybrid",
            "hybrid support"
        ];

        if (
            typeof body.onsite !== "string" ||
            !legacyOnsiteValues.includes(body.onsite.trim().toLowerCase())
        ) {
            return "On-site indicator must be a boolean or a supported legacy service-mode value.";
        }
    }

    return null;
}

function isCreditBillableTicket(ticket) {
    const isOnSite = String(ticket["Support Type"] || "").trim().toLowerCase() === "on-site support";
    if (!isOnSite) {
        return false;
    }
    if (String(ticket["On-site Support Type"] || "").trim().toLowerCase() === "project") {
        return isProjectCreditTicket(ticket);
    }
    return true;
}

function isProjectCreditTicket(ticket) {
    return (
        String(ticket["Support Type"] || "").trim().toLowerCase() === "on-site support" &&
        String(ticket["On-site Support Type"] || "").trim().toLowerCase() === "project" &&
        Object.hasOwn(ticket, "Project Estimated Hours") &&
        Number.isFinite(Number(ticket["Project Estimated Hours"])) &&
        Number(ticket["Project Estimated Hours"]) > 0
    );
}

function getTicketEstimatedCredits(ticket) {
    if (!isCreditBillableTicket(ticket)) {
        return 0;
    }

    if (isProjectCreditTicket(ticket)) {
        return Number(ticket["Project Estimated Hours"]);
    }

    const duration = Number(ticket["Appointment Duration"] || 0);
    return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function findTicketCustomer(customersData, ticket) {
    const customerId = String(ticket["Customer ID"] || "").trim();
    let customerIndex = customerId
        ? customersData.findIndex(
            customer => String(customer["Customer ID"] || "").trim() === customerId
        )
        : -1;

    if (customerIndex === -1) {
        const email = String(ticket.Email || "").trim().toLowerCase();
        if (email) {
            customerIndex = customersData.findIndex(
                customer => String(customer.Email || "").trim().toLowerCase() === email
            );
        }
    }

    return customerIndex;
}

function getCustomerDirectoryEntry(customer, customerTickets) {
    const ticketSummary = ticket => ({
        ticketId: String(ticket["Ticket ID"] || ""),
        issue: String(ticket.Issue || ""),
        supportType: String(ticket["Support Type"] || ""),
        status: String(ticket.Status || ""),
        assignedEngineer: String(ticket["Assigned Engineer"] || ""),
        createdDate: String(ticket["Created Date"] || ""),
        unpaidCredits: Number(ticket["Unpaid Credits"] || 0)
    });
    const openTickets = customerTickets.filter(ticket => ticket.Status === "Open");
    const inProgressTickets = customerTickets.filter(
        ticket => ticket.Status === "In Progress" || ticket.Status === "Pending"
    );
    const closedTickets = customerTickets.filter(ticket => ticket.Status === "Closed");
    const pendingPaymentTickets = customerTickets.filter(ticket => {
        const unpaidCredits = Number(ticket["Unpaid Credits"] || 0);
        return Number.isFinite(unpaidCredits) && unpaidCredits > 0;
    });

    return {
        customer: {
            id: String(customer["Customer ID"] || ""),
            name: String(customer.Name || ""),
            email: String(customer.Email || ""),
            credits: customer.Credits ?? 0
        },
        ticketCounts: {
            total: customerTickets.length,
            open: openTickets.length,
            inProgress: inProgressTickets.length,
            pendingPayment: pendingPaymentTickets.length,
            closed: closedTickets.length
        },
        tickets: {
            open: openTickets.map(ticketSummary),
            inProgress: inProgressTickets.map(ticketSummary),
            pendingPayment: pendingPaymentTickets.map(ticketSummary),
            closed: closedTickets.map(ticketSummary)
        }
    };
}

function getCustomerDirectoryEntries(customersData, ticketsData) {
    const ticketsByCustomer = customersData.map(() => []);

    ticketsData.forEach(ticket => {
        const customerIndex = findTicketCustomer(customersData, ticket);
        if (customerIndex !== -1) {
            ticketsByCustomer[customerIndex].push(ticket);
        }
    });

    return customersData.map((customer, index) =>
        getCustomerDirectoryEntry(customer, ticketsByCustomer[index])
    );
}

function settleTicketCredits(workbook, ticket, billableCredits) {
    const estimatedCredits = getTicketEstimatedCredits(ticket);
    const storedChargedCredits = ticket["Credits Charged"];
    const chargedCredits = storedChargedCredits === undefined || storedChargedCredits === ""
        ? estimatedCredits
        : Number(storedChargedCredits);
    const storedBillableCredits = ticket["Billable Credits"];
    const previousBillableCredits = storedBillableCredits === undefined || storedBillableCredits === ""
        ? chargedCredits
        : Number(storedBillableCredits);

    if (
        !Number.isFinite(chargedCredits) ||
        !Number.isFinite(previousBillableCredits) ||
        !Number.isFinite(billableCredits) ||
        billableCredits < 0
    ) {
        return { error: "Ticket credit information is invalid." };
    }

    let customerCredits = 0;
    let additionalCredits = 0;
    let refundedCredits = 0;
    let actualChargedCredits = chargedCredits;

    if (billableCredits !== previousBillableCredits) {
        const customerWorksheet = workbook.Sheets["Customer"];
        if (!customerWorksheet) {
            return { error: "Customer sheet not found; ticket credits could not be settled." };
        }

        const customersData = XLSX.utils.sheet_to_json(customerWorksheet);
        const customerIndex = findTicketCustomer(customersData, ticket);
        if (customerIndex === -1) {
            return { error: "Customer not found; ticket credits could not be settled." };
        }

        const customer = customersData[customerIndex];
        const currentCredits = Number(customer.Credits || 0);
        if (!Number.isFinite(currentCredits)) {
            return { error: "Customer credit balance is invalid." };
        }

        if (billableCredits > previousBillableCredits) {
            const difference = billableCredits - previousBillableCredits;
            additionalCredits = Math.min(difference, Math.max(0, currentCredits));
            customer.Credits = currentCredits - additionalCredits;
            actualChargedCredits += additionalCredits;
        } else {
            refundedCredits = Math.max(0, actualChargedCredits - billableCredits);
            customer.Credits = currentCredits + refundedCredits;
            actualChargedCredits -= refundedCredits;
        }

        customerCredits = Number(customer.Credits);
        workbook.Sheets["Customer"] = XLSX.utils.json_to_sheet(customersData);
    }

    ticket["Credits Charged"] = actualChargedCredits;
    ticket["Billable Credits"] = billableCredits;
    ticket["Unpaid Credits"] = Math.max(0, billableCredits - actualChargedCredits);
    ticket["Credit Settlement Status"] = "Settled";

    return {
        actualChargedCredits,
        additionalCredits,
        refundedCredits,
        unpaidCredits: ticket["Unpaid Credits"],
        remainingCredits: customerCredits
    };
}

function settleProjectTicketCredits(workbook, ticket, billableCredits, finalized) {
    const estimatedCredits = getTicketEstimatedCredits(ticket);
    const storedChargedCredits = ticket["Credits Charged"];
    const chargedCredits = storedChargedCredits === undefined || storedChargedCredits === ""
        ? estimatedCredits
        : Number(storedChargedCredits);

    if (
        !Number.isFinite(estimatedCredits) ||
        estimatedCredits <= 0 ||
        !Number.isFinite(chargedCredits) ||
        chargedCredits < 0 ||
        !Number.isFinite(billableCredits) ||
        billableCredits < 0
    ) {
        return { error: "Project credit information is invalid." };
    }

    const targetCharge = finalized
        ? billableCredits
        : Math.max(estimatedCredits, billableCredits);
    const difference = targetCharge - chargedCredits;
    let additionalCredits = 0;
    let refundedCredits = 0;
    let remainingCredits = null;
    let actualChargedCredits = chargedCredits;

    if (difference !== 0) {
        const customerWorksheet = workbook.Sheets.Customer;
        if (!customerWorksheet) {
            return { error: "Customer sheet not found; Project credits could not be settled." };
        }
        const customersData = XLSX.utils.sheet_to_json(customerWorksheet);
        const customerIndex = findTicketCustomer(customersData, ticket);
        if (customerIndex === -1) {
            return { error: "Customer not found; Project credits could not be settled." };
        }
        const customer = customersData[customerIndex];
        const currentCredits = Number(customer.Credits || 0);
        if (!Number.isFinite(currentCredits) || currentCredits < 0) {
            return { error: "Customer credit balance is invalid." };
        }

        if (difference > 0) {
            additionalCredits = Math.min(difference, currentCredits);
            customer.Credits = currentCredits - additionalCredits;
            actualChargedCredits += additionalCredits;
        } else {
            refundedCredits = Math.min(-difference, actualChargedCredits);
            customer.Credits = currentCredits + refundedCredits;
            actualChargedCredits -= refundedCredits;
        }
        remainingCredits = Number(customer.Credits);
        workbook.Sheets.Customer = XLSX.utils.json_to_sheet(customersData);
    }

    const unpaidCredits = Math.max(0, billableCredits - actualChargedCredits);
    ticket["Credits Charged"] = actualChargedCredits;
    ticket["Billable Credits"] = billableCredits;
    ticket["Unpaid Credits"] = unpaidCredits;
    ticket["Credit Settlement Status"] = finalized ? "Settled" : "Pending";

    return {
        actualChargedCredits,
        additionalCredits,
        refundedCredits,
        unpaidCredits,
        remainingCredits,
        billableCredits,
        finalized
    };
}

function getProjectTicketBillableCredits(reports, ticketId) {
    return reports
        .filter(report => String(report["Ticket ID"] || "").trim() === String(ticketId).trim())
        .reduce((total, report) => {
            const billableCredits = Number(report["Billable Credits"]);
            return total + (
                Number.isFinite(billableCredits) && billableCredits >= 0
                    ? billableCredits
                    : calculateBillableServiceReportCredits(
                        String(report.SignInTime || ""),
                        String(report.SignOutTime || "")
                    )
            );
        }, 0);
}

function areProjectAppointmentsFinalized(appointments, ticketId) {
    const projectAppointments = appointments.filter(appointment =>
        String(appointment["Ticket ID"] || "").trim() === String(ticketId).trim() &&
        Number(appointment["Project Days"] || 0) > 0
    );
    return projectAppointments.length > 0 && projectAppointments.every(appointment =>
        ["Completed", "Cancelled"].includes(String(appointment.Status || ""))
    );
}

function getServiceReportCreditMessage(ticket, billableCredits, settlement) {
    if (!isCreditBillableTicket(ticket)) {
        return String(ticket["On-site Support Type"] || "").trim().toLowerCase() === "project"
            ? "Service report generated and saved successfully. Project tickets are exempt from credits."
            : "Service report generated and saved successfully.";
    }

    const adjustments = [];
    if (settlement.refundedCredits > 0) {
        adjustments.push(`${settlement.refundedCredits} credit(s) refunded`);
    }
    if (settlement.additionalCredits > 0) {
        adjustments.push(`${settlement.additionalCredits} additional credit(s) charged`);
    }
    if (settlement.unpaidCredits > 0) {
        adjustments.push(`${settlement.unpaidCredits} unpaid credit(s) flagged for staff`);
    }

    return [
        `Service report generated and saved successfully. Final billable amount: ${billableCredits} credit(s).`,
        ...adjustments
    ].join(" ");
}

function addCustomerToIndexes(customerIndexes, customer, customerIndex) {
    const customerId = String(customer["Customer ID"] || "");
    const trimmedCustomerId = customerId.trim();
    const normalizedEmail = normalizeEmail(customer.Email || "");

    if (!customerIndexes.byId.has(customerId)) {
        customerIndexes.byId.set(customerId, customerIndex);
    }

    if (trimmedCustomerId) {
        if (!customerIndexes.byTrimmedId.has(trimmedCustomerId)) {
            customerIndexes.byTrimmedId.set(trimmedCustomerId, customerIndex);
        }
        customerIndexes.usedIds.add(trimmedCustomerId);
    }

    if (normalizedEmail && !customerIndexes.byEmail.has(normalizedEmail)) {
        customerIndexes.byEmail.set(normalizedEmail, customerIndex);
    }
}

function createCustomerIndexes(customersData) {
    const customerIndexes = {
        byId: new Map(),
        byTrimmedId: new Map(),
        byEmail: new Map(),
        usedIds: new Set()
    };

    customersData.forEach((customer, customerIndex) => {
        addCustomerToIndexes(customerIndexes, customer, customerIndex);
    });

    return customerIndexes;
}

function getNextCustomerId(customerIndexes) {
    let candidate = 1;

    while (true) {
        const candidateId = `C-${String(candidate).padStart(13, "0")}`;

        if (!customerIndexes.usedIds.has(candidateId)) {
            return candidateId;
        }

        candidate += 1;
    }
}

function resolveCustomerForTicket(
    customersData,
    submittedCustomerId,
    submittedEmail,
    submittedName,
    customerIndexes = createCustomerIndexes(customersData)
) {
    const normalizedEmail = normalizeEmail(submittedEmail);

    if (submittedCustomerId) {
        const customerIndex = customerIndexes.byId.get(String(submittedCustomerId));

        if (customerIndex === undefined) {
            return { customer: null, customerIndex: -1, created: false, reason: "Customer not found." };
        }

        const customer = customersData[customerIndex];

        if (!String(customer.Name || "").trim() && submittedName) {
            customer.Name = submittedName;
        }

        return { customer, customerIndex, created: false, reason: null };
    }

    if (!normalizedEmail) {
        return { customer: null, customerIndex: -1, created: false, reason: null };
    }

    const customerIndex = customerIndexes.byEmail.get(normalizedEmail);

    if (customerIndex !== undefined) {
        const customer = customersData[customerIndex];

        if (!String(customer.Name || "").trim() && submittedName) {
            customer.Name = submittedName;
        }

        return { customer, customerIndex, created: false, reason: null };
    }

    const newCustomer = {
        "Customer ID": getNextCustomerId(customerIndexes),
        "Name": submittedName || "",
        "Email": submittedEmail || "",
        "Password": "",
        "Credits": 0
    };

    const newCustomerIndex = customersData.length;
    customersData.push(newCustomer);
    addCustomerToIndexes(customerIndexes, newCustomer, newCustomerIndex);

    return { customer: newCustomer, customerIndex: newCustomerIndex, created: true, reason: null };
}

function repairMissingCustomerLinks(workbook) {
    const customerWorksheet = workbook.Sheets["Customer"];
    const ticketWorksheet = workbook.Sheets["Ticket"];

    if (!customerWorksheet || !ticketWorksheet) {
        return { fixedCount: 0, changed: false };
    }

    const customersData = XLSX.utils.sheet_to_json(customerWorksheet);
    const ticketsData = XLSX.utils.sheet_to_json(ticketWorksheet);
    const customerIndexes = createCustomerIndexes(customersData);

    let changed = false;
    let fixedCount = 0;

    for (const ticket of ticketsData) {
        const ticketCustomerId = String(ticket["Customer ID"] || "").trim();
        const ticketEmail = String(ticket["Email"] || "").trim();
        const ticketName = String(ticket["Customer Name"] || "").trim();

        if (!ticketCustomerId && !ticketEmail) {
            continue;
        }

        let matchedCustomer = null;

        if (ticketCustomerId) {
            const customerIndex = customerIndexes.byTrimmedId.get(ticketCustomerId);
            if (customerIndex !== undefined) {
                matchedCustomer = customersData[customerIndex];
            }
        }

        if (!matchedCustomer && ticketEmail) {
            const customerIndex = customerIndexes.byEmail.get(normalizeEmail(ticketEmail));
            if (customerIndex !== undefined) {
                matchedCustomer = customersData[customerIndex];
            }
        }

        if (!matchedCustomer && ticketEmail) {
            const createdCustomer = resolveCustomerForTicket(
                customersData,
                "",
                ticketEmail,
                ticketName,
                customerIndexes
            );

            matchedCustomer = createdCustomer.customer;
            changed = true;
            fixedCount += 1;
        }

        if (!matchedCustomer) {
            continue;
        }

        if (!String(ticket["Customer ID"] || "").trim()) {
            ticket["Customer ID"] = matchedCustomer["Customer ID"] || "";
            changed = true;
        }

        if (!String(ticket["Customer Name"] || "").trim() && matchedCustomer.Name) {
            ticket["Customer Name"] = matchedCustomer.Name;
            changed = true;
        }

        if (!String(ticket["Email"] || "").trim() && matchedCustomer.Email) {
            ticket["Email"] = matchedCustomer.Email;
            changed = true;
        }
    }

    if (!changed) {
        return { fixedCount: 0, changed: false };
    }

    workbook.Sheets["Customer"] = XLSX.utils.json_to_sheet(customersData);
    workbook.Sheets["Ticket"] = XLSX.utils.json_to_sheet(ticketsData);
    writeWorkbook(workbook);

    return { fixedCount, changed: true };
}

/* =========================
   MIDDLEWARE
========================= */

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
    );
    next();
});

app.use(express.json({ limit: "32kb" }));

app.use(
    express.static(
        path.join(__dirname, "public")
    )
);


/* =========================
   HOME PAGE
========================= */

app.get("/", (req, res) => {

    res.sendFile(
        path.join(
            __dirname,
            "public",
            "index.html"
        )
    );

});


/* =========================================================
   DISABLED CUSTOMER-FACING AREA
   =========================================
   Legacy customer UX and customer APIs are intentionally disabled.
   The original logic has been preserved in-place for later re-enable,
   but the active routes below now fail fast instead of running.

   To restore the old behavior, remove the disabled stubs and re-enable
   the original customer handlers.
========================================================= */

app.post("/api/customers/signup", (req, res) => {
    return res.status(410).json({
        message: "Customer signup is currently disabled."
    });
});


/* =========================================================
   CUSTOMER LOGIN
========================================================= */

app.post("/api/customers/login", (req, res) => {
    return res.status(410).json({
        message: "Customer login is currently disabled."
    });
});

/* =========================================================
   END DISABLED CUSTOMER-FACING AREA
========================================================= */


/* =========================================================
    STAFF LOGIN
========================================================= */

/* TEMPORARY STAFF LOGIN LOGGING LANDMARK
    Remove temporary verbose logging below before production. Never log passwords.
*/
app.post("/api/staff/login", loginRateLimiter, (req, res) => {

    try {

        const {
            email,
            password
        } = req.body;


        if (!email || !password) {

            return res.status(400).json({

                message:
                    "Please enter your email and password."

            });

        }


        const workbook =
            XLSX.readFile(excelFile);

        const worksheet =
            workbook.Sheets["Staff"];


        if (!worksheet) {

            return res.status(500).json({

                message:
                    "Staff sheet not found in database.xlsx."

            });

        }


        const staffData =
            XLSX.utils.sheet_to_json(
                worksheet
            );


        console.log(
            "Staff login attempt:",
            email
        );


        const staff =
            staffData.find(
                staff => {

                    const staffEmail =
                        String(
                            staff.Email || ""
                        )
                        .trim()
                        .toLowerCase();


                    const enteredEmail =
                        String(email)
                        .trim()
                        .toLowerCase();


                    const staffPassword =
                        String(
                            staff.Password || ""
                        );


                    const enteredPassword =
                        String(password);


                    return (
                        staffEmail === enteredEmail &&
                        verifyStaffPassword(enteredPassword, staffPassword)
                    );

                }
            );


        if (!staff) {

            console.log(
                "Staff login failed for:",
                email
            );

            return res.status(401).json({

                message:
                    "Invalid email or password."

            });

        }


        console.log(
            "Staff login successful:",
            staff.Email
        );


        for (const [token, existingSession] of staffSessions) {
            if (existingSession.expiresAt <= Date.now()) {
                staffSessions.delete(token);
            }
        }
        staffSessions.delete(getStaffSessionToken(req));

        const sessionToken = crypto.randomBytes(32).toString("hex");
        const session = {
            staffId: String(staff["Staff ID"] || ""),
            email: String(staff.Email || "").trim().toLowerCase(),
            expiresAt: Date.now() + STAFF_SESSION_TTL_MS
        };
        staffSessions.set(sessionToken, session);
        setStaffSessionCookie(
            req,
            res,
            sessionToken,
            STAFF_SESSION_TTL_MS / 1000
        );

        res.json({

            message:
                "Login successful.",

            staff: staffProfile(staff)

        });

    } catch (error) {

        console.error(
            "Staff login error:",
            error
        );

        res.status(500).json({

            message:
                "Unable to process staff login."

        });

    }

});

app.get("/api/staff/profile", requireStaffSession, (req, res) => {
    try {
        const workbook = XLSX.readFile(excelFile);
        const worksheet = workbook.Sheets.Staff;

        if (!worksheet) {
            return res.status(404).json({ message: "Staff sheet not found." });
        }

        const staffData = XLSX.utils.sheet_to_json(worksheet);
        const staff = findStaffForSession(staffData, req.staffSession);

        if (!staff) {
            staffSessions.delete(getStaffSessionToken(req));
            setStaffSessionCookie(req, res, "", 0);
            return res.status(401).json({ message: "Please log in to continue." });
        }

        return res.json({ staff: staffProfile(staff) });
    } catch (error) {
        console.error("Get staff profile error:", error);
        return res.status(500).json({ message: "Unable to load staff profile." });
    }
});

app.get("/api/staff/directory", requireStaffSession, (req, res) => {
    try {
        const workbook = XLSX.readFile(excelFile);
        const { roster, changed } = ensureStaffRoster(workbook);
        const accountStaff = workbook.Sheets.Staff
            ? XLSX.utils.sheet_to_json(workbook.Sheets.Staff).map(person => ({
                staffId: String(person["Staff ID"] || ""),
                name: String(person.Name || ""),
                email: String(person.Email || "")
            }))
            : [];
        const tickets = workbook.Sheets.Ticket
            ? XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
            : [];
        const unassignedTickets = tickets
            .filter(ticket =>
                String(ticket["Ticket ID"] || "").trim() &&
                !String(ticket["Assigned Staff ID"] || "").trim() &&
                !String(ticket["Assigned Engineer"] || "").trim()
            )
            .map(ticket => ({
                ticketId: String(ticket["Ticket ID"] || ""),
                issue: String(ticket.Issue || ""),
                status: String(ticket.Status || "")
            }));
        const appointments = readAppointments(workbook);

        if (changed) {
            writeWorkbook(workbook);
        }

        const staff = roster.map(person => {
            const staffId = String(person["Staff ID"] || "");
            return {
                staffId,
                name: String(person.Name || ""),
                role: String(person.Role || ""),
                department: String(person.Department || ""),
                email: String(person.Email || ""),
                phone: String(person.Phone || ""),
                active: String(person.Active || "Yes").toLowerCase() !== "no",
                loginStaffId: String(person["Login Staff ID"] || ""),
                tickets: tickets.filter(ticket =>
                    String(ticket["Assigned Staff ID"] || "") === staffId ||
                    (
                        !ticket["Assigned Staff ID"] &&
                        String(ticket["Assigned Engineer"] || "") === String(person.Name || "")
                    )
                ),
                appointments: appointments.filter(appointment =>
                    String(appointment["Staff ID"] || "") === staffId
                )
            };
        });

        return res.json({ staff, loginAccounts: accountStaff, unassignedTickets });
    } catch (error) {
        console.error("Get staff directory error:", error);
        return res.status(500).json({ message: "Unable to load the staff directory." });
    }
});

app.post("/api/staff/directory", requireStaffSession, (req, res) => {
    try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const role = typeof body.role === "string" ? body.role.trim() : "";
        const department = typeof body.department === "string" ? body.department.trim() : "";
        const email = typeof body.email === "string" ? body.email.trim() : "";
        const phone = typeof body.phone === "string" ? body.phone.trim() : "";
        const loginStaffId = typeof body.loginStaffId === "string" ? body.loginStaffId.trim() : "";
        const active = body.active !== false;
        if (!name || name.length > 120 || !role || role.length > 80) {
            return res.status(400).json({ message: "Name and role are required (maximum 120 and 80 characters)." });
        }
        if (department.length > 120 || email.length > 254 || phone.length > 40) {
            return res.status(400).json({ message: "One or more staff fields exceed their maximum length." });
        }
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ message: "Please provide a valid staff email address." });
        }

        const workbook = XLSX.readFile(excelFile);
        const { roster } = ensureStaffRoster(workbook);
        const loginAccounts = workbook.Sheets.Staff
            ? XLSX.utils.sheet_to_json(workbook.Sheets.Staff)
            : [];
        if (loginStaffId && !loginAccounts.some(account =>
            String(account["Staff ID"] || "") === loginStaffId
        )) {
            return res.status(400).json({ message: "Choose a valid linked login account." });
        }
        if (loginStaffId && roster.some(person =>
            String(person["Login Staff ID"] || "") === loginStaffId
        )) {
            return res.status(409).json({ message: "This login account is already linked to a staff record." });
        }
        if (email && roster.some(person => normalizeEmail(person.Email) === normalizeEmail(email))) {
            return res.status(409).json({ message: "A staff record with this email already exists." });
        }
        const record = {
            "Staff ID": `R-${crypto.randomUUID()}`,
            Name: name,
            Role: role,
            Department: department,
            Email: email,
            Phone: phone,
            Active: active ? "Yes" : "No",
            "Login Staff ID": loginStaffId
        };
        roster.push(record);
        setWorkbookSheet(workbook, "StaffRoster", XLSX.utils.json_to_sheet(roster, { header: STAFF_ROSTER_COLUMNS }));
        writeWorkbook(workbook);
        return res.status(201).json({
            staff: {
                staffId: record["Staff ID"], name, role, department, email, phone, active,
                loginStaffId
            }
        });
    } catch (error) {
        console.error("Create staff record error:", error);
        return res.status(500).json({ message: "Unable to create the staff record." });
    }
});

app.post("/api/staff/tickets/:ticketId/assignment", requireStaffSession, (req, res) => {
    try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const staffId = typeof body.staffId === "string" ? body.staffId.trim() : "";
        if (!staffId) {
            return res.status(400).json({ message: "Choose a staff member for this ticket." });
        }

        const workbook = XLSX.readFile(excelFile);
        const ticketSheet = workbook.Sheets.Ticket;
        if (!ticketSheet) {
            return res.status(404).json({ message: "Ticket sheet not found." });
        }
        const tickets = XLSX.utils.sheet_to_json(ticketSheet);
        const ticket = tickets.find(row =>
            String(row["Ticket ID"] || "") === req.params.ticketId
        );
        if (!ticket) {
            return res.status(404).json({ message: "Ticket not found." });
        }
        if (
            String(ticket["Assigned Staff ID"] || "").trim() ||
            String(ticket["Assigned Engineer"] || "").trim()
        ) {
            return res.status(409).json({ message: "This ticket is already assigned." });
        }

        const { roster } = ensureStaffRoster(workbook);
        const selected = roster.find(person =>
            String(person["Staff ID"] || "") === staffId
        );
        if (!selected || String(selected.Active || "Yes").toLowerCase() === "no") {
            return res.status(400).json({ message: "Choose an active staff member." });
        }

        ticket["Assigned Staff ID"] = staffId;
        ticket["Assigned Engineer"] = String(selected.Name || "");
        setWorkbookSheet(workbook, "StaffRoster", XLSX.utils.json_to_sheet(roster, { header: STAFF_ROSTER_COLUMNS }));
        setWorkbookSheet(workbook, "Ticket", XLSX.utils.json_to_sheet(tickets));
        writeWorkbook(workbook, () => {
            const latestWorkbook = XLSX.readFile(excelFile);
            const latestTicketSheet = latestWorkbook.Sheets.Ticket;
            const latestTickets = latestTicketSheet
                ? XLSX.utils.sheet_to_json(latestTicketSheet)
                : [];
            const latestTicket = latestTickets.find(row =>
                String(row["Ticket ID"] || "") === req.params.ticketId
            );
            if (!latestTicket) {
                const error = new Error("Ticket not found.");
                error.code = "TICKET_NOT_FOUND";
                throw error;
            }
            if (
                String(latestTicket["Assigned Staff ID"] || "").trim() ||
                String(latestTicket["Assigned Engineer"] || "").trim()
            ) {
                const error = new Error("This ticket is already assigned.");
                error.code = "TICKET_ALREADY_ASSIGNED";
                throw error;
            }
            const latestRoster = ensureStaffRoster(latestWorkbook).roster;
            const latestSelected = latestRoster.find(person =>
                String(person["Staff ID"] || "") === staffId
            );
            if (!latestSelected || String(latestSelected.Active || "Yes").toLowerCase() === "no") {
                const error = new Error("Choose an active staff member.");
                error.code = "INVALID_ASSIGNMENT_STAFF";
                throw error;
            }
            latestTicket["Assigned Staff ID"] = staffId;
            latestTicket["Assigned Engineer"] = String(latestSelected.Name || "");
            setWorkbookSheet(
                workbook,
                "StaffRoster",
                XLSX.utils.json_to_sheet(latestRoster, { header: STAFF_ROSTER_COLUMNS })
            );
            setWorkbookSheet(workbook, "Ticket", XLSX.utils.json_to_sheet(latestTickets));
        });
        return res.json({ ticketId: req.params.ticketId, staffId });
    } catch (error) {
        if (error && error.code === "DATABASE_LOCKED") {
            return res.status(409).json({ message: error.message });
        }
        if (error && error.code === "TICKET_NOT_FOUND") {
            return res.status(404).json({ message: error.message });
        }
        if (error && error.code === "TICKET_ALREADY_ASSIGNED") {
            return res.status(409).json({ message: error.message });
        }
        if (error && error.code === "INVALID_ASSIGNMENT_STAFF") {
            return res.status(400).json({ message: error.message });
        }
        console.error("Assign ticket to staff error:", error);
        return res.status(500).json({ message: "Unable to assign the ticket." });
    }
});

app.patch("/api/staff/directory/:staffId", requireStaffSession, (req, res) => {
    try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const workbook = XLSX.readFile(excelFile);
        const { roster } = ensureStaffRoster(workbook);
        const index = roster.findIndex(person =>
            String(person["Staff ID"] || "") === req.params.staffId
        );
        if (index === -1) {
            return res.status(404).json({ message: "Staff record not found." });
        }

        const updates = [
            ["name", "Name", 120],
            ["role", "Role", 80],
            ["department", "Department", 120],
            ["email", "Email", 254],
            ["phone", "Phone", 40]
        ];
        for (const [field, column, maxLength] of updates) {
            if (body[field] === undefined) {
                continue;
            }
            if (body.loginStaffId !== undefined) {
                if (typeof body.loginStaffId !== "string") {
                    return res.status(400).json({ message: "Linked login account must be an account ID or empty." });
                }
                const loginStaffId = body.loginStaffId.trim();
                const accounts = workbook.Sheets.Staff
                    ? XLSX.utils.sheet_to_json(workbook.Sheets.Staff)
                    : [];
                if (loginStaffId && !accounts.some(account =>
                    String(account["Staff ID"] || "") === loginStaffId
                )) {
                    return res.status(400).json({ message: "Choose a valid linked login account." });
                }
                if (loginStaffId && roster.some((person, row) =>
                    row !== index && String(person["Login Staff ID"] || "") === loginStaffId
                )) {
                    return res.status(409).json({ message: "This login account is already linked to a staff record." });
                }
                roster[index]["Login Staff ID"] = loginStaffId;
            }
            if (typeof body[field] !== "string" || body[field].trim().length > maxLength) {
                return res.status(400).json({ message: `${field} must be text with at most ${maxLength} characters.` });
            }
            roster[index][column] = body[field].trim();
        }
        if (body.active !== undefined) {
            if (typeof body.active !== "boolean") {
                return res.status(400).json({ message: "Active status must be a boolean." });
            }
            roster[index].Active = body.active ? "Yes" : "No";
        }
        const email = normalizeEmail(roster[index].Email);
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ message: "Please provide a valid staff email address." });
        }
        if (email && roster.some((person, row) =>
            row !== index && normalizeEmail(person.Email) === email
        )) {
            return res.status(409).json({ message: "A staff record with this email already exists." });
        }
        if (!String(roster[index].Name || "").trim() || !String(roster[index].Role || "").trim()) {
            return res.status(400).json({ message: "Name and role are required." });
        }

        setWorkbookSheet(workbook, "StaffRoster", XLSX.utils.json_to_sheet(roster, { header: STAFF_ROSTER_COLUMNS }));
        writeWorkbook(workbook);
        return res.json({
            staff: {
                staffId: String(roster[index]["Staff ID"]),
                name: String(roster[index].Name || ""),
                role: String(roster[index].Role || ""),
                department: String(roster[index].Department || ""),
                email: String(roster[index].Email || ""),
                phone: String(roster[index].Phone || ""),
                active: String(roster[index].Active).toLowerCase() !== "no",
                loginStaffId: String(roster[index]["Login Staff ID"] || "")
            }
        });
    } catch (error) {
        console.error("Update staff record error:", error);
        return res.status(500).json({ message: "Unable to update the staff record." });
    }
});

app.get("/api/staff/appointments", requireStaffSession, (req, res) => {
    try {
        const workbook = XLSX.readFile(excelFile);
        ensureStaffRoster(workbook);
        return res.json(readAppointments(workbook));
    } catch (error) {
        console.error("Get appointment schedule error:", error);
        return res.status(500).json({ message: "Unable to load appointments." });
    }
});

app.get("/api/staff/appointments/:appointmentId/available-staff", requireStaffSession, (req, res) => {
    try {
        const workbook = XLSX.readFile(excelFile);
        const { roster } = ensureStaffRoster(workbook);
        const appointments = readAppointments(workbook);
        const appointment = appointments.find(record =>
            String(record["Appointment ID"] || "") === req.params.appointmentId
        );
        if (!appointment) {
            return res.status(404).json({ message: "Appointment not found." });
        }

        const otherAppointments = appointments.filter(record =>
            String(record["Appointment ID"] || "") !== req.params.appointmentId
        );
        const availableStaff = roster
            .filter(person =>
                String(person.Active || "Yes").toLowerCase() !== "no" &&
                getStaffRoleEligibility(person) &&
                !hasSchedulingConflict(
                    { ...appointment, "Staff ID": String(person["Staff ID"] || "") },
                    otherAppointments
                )
            )
            .map(person => ({
                staffId: String(person["Staff ID"] || ""),
                name: String(person.Name || ""),
                role: String(person.Role || "")
            }));
        return res.json(availableStaff);
    } catch (error) {
        console.error("Get available appointment staff error:", error);
        return res.status(500).json({ message: "Unable to load available staff for this appointment." });
    }
});

app.patch("/api/staff/appointments/:appointmentId", requireStaffSession, (req, res) => {
    try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const workbook = XLSX.readFile(excelFile);
        const { roster } = ensureStaffRoster(workbook);
        const appointments = readAppointments(workbook);
        const appointmentIndex = appointments.findIndex(appointment =>
            String(appointment["Appointment ID"] || "") === req.params.appointmentId
        );
        if (appointmentIndex === -1) {
            return res.status(404).json({ message: "Appointment not found." });
        }

        const appointment = appointments[appointmentIndex];
        if (body.status !== undefined) {
            if (!["Pending", "Confirmed", "Reschedule Required", "Cancelled"].includes(body.status)) {
                return res.status(400).json({ message: "Please select a valid appointment status." });
            }
            appointment.Status = body.status;
        }
        if (body.staffId !== undefined) {
            if (typeof body.staffId !== "string") {
                return res.status(400).json({ message: "Choose an active technician eligible for appointments." });
            }
            const staffId = body.staffId.trim();
            if (!staffId) {
                appointment["Staff ID"] = "";
                appointment.Status = "Reschedule Required";
                appointment["Scheduling Note"] = "No technician is assigned. Scheduling follow-up is required.";
            } else {
                const selected = roster.find(person =>
                    String(person["Staff ID"] || "") === staffId
                );
                if (!selected || String(selected.Active || "Yes").toLowerCase() === "no" || !getStaffRoleEligibility(selected)) {
                    return res.status(400).json({ message: "Choose an active technician eligible for appointments." });
                }
                const candidate = { ...appointment, "Staff ID": String(selected["Staff ID"]) };
                if (hasSchedulingConflict(candidate, appointments.filter((_, index) => index !== appointmentIndex))) {
                    return res.status(409).json({ message: "This technician is unavailable at the requested time or travel buffer." });
                }
                appointment["Staff ID"] = String(selected["Staff ID"]);
                appointment.Status = "Pending";
                appointment["Scheduling Note"] = "";
            }
        }

        if (body.date !== undefined || body.time !== undefined || body.durationHours !== undefined) {
            if (Number(appointment["Project Days"] || 0) > 0) {
                return res.status(400).json({ message: "Project dates must be changed as a project booking." });
            }
            const date = body.date === undefined ? String(appointment["Start Date"]) : String(body.date);
            const time = body.time === undefined ? String(appointment["Start Time"]) : String(body.time);
            const dateValidation = validateAppointmentDateTime(date, time);
            if (dateValidation) {
                return res.status(400).json({ message: dateValidation });
            }
            const durationHours = body.durationHours === undefined
                ? (localDateTime(appointment["End Date"], appointment["End Time"]) -
                    localDateTime(appointment["Start Date"], appointment["Start Time"])) / 3600000
                : Number(body.durationHours);
            const businessHoursError = validateAppointmentBusinessHours(
                time,
                durationHours
            );
            if (businessHoursError) {
                return res.status(400).json({ message: businessHoursError });
            }
            const interval = getAppointmentCandidate({
                date, time, durationHours,
                address: appointment.Address,
                ticketId: appointment["Ticket ID"]
            });
            if (!interval) {
                return res.status(400).json({ message: "Provide a valid date, time, and positive duration." });
            }
            const candidate = {
                ...appointment,
                "Start Date": interval["Start Date"],
                "Start Time": interval["Start Time"],
                "End Date": interval["End Date"],
                "End Time": interval["End Time"]
            };
            if (
                appointment["Staff ID"] &&
                hasSchedulingConflict(candidate, appointments.filter((_, index) => index !== appointmentIndex))
            ) {
                return res.status(409).json({ message: "This technician is unavailable at the requested time or travel buffer." });
            }
            Object.assign(appointment, candidate);
        }

        if (
            Number(appointment["Project Days"] || 0) > 0 &&
            (body.projectDays !== undefined || body.projectDayMode !== undefined || body.date !== undefined)
        ) {
            let recordedSessions;
            try {
                recordedSessions = JSON.parse(String(appointment["Service Sessions"] || "[]"));
            } catch (error) {
                throw new Error("Stored Project service sessions are invalid.", { cause: error });
            }
            if (!Array.isArray(recordedSessions)) {
                throw new Error("Stored Project service sessions must be a list.");
            }
            if (recordedSessions.length > 0) {
                return res.status(409).json({ message: "A Project booking cannot be moved after service sessions have been recorded." });
            }
            const projectDays = body.projectDays === undefined
                ? Number(appointment["Project Days"])
                : Number(body.projectDays);
            const projectDayMode = body.projectDayMode === undefined
                ? String(appointment["Project Day Mode"] || "calendar")
                : String(body.projectDayMode);
            const date = body.date === undefined
                ? String(appointment["Start Date"])
                : String(body.date);
            const dateValidation = validateProjectBookingDate(date);
            if (!Number.isInteger(projectDays) || projectDays < 1 || !["calendar", "weekdays"].includes(projectDayMode) || dateValidation) {
                return res.status(400).json({ message: "Provide a valid project start date, day count, and reservation mode." });
            }
            const projectCandidate = getAppointmentCandidate({
                date,
                time: "00:00",
                projectDays,
                projectDayMode,
                address: appointment.Address,
                ticketId: appointment["Ticket ID"]
            });
            const updatedProject = {
                ...appointment,
                "Start Date": projectCandidate["Start Date"],
                "Start Time": projectCandidate["Start Time"],
                "End Date": projectCandidate["End Date"],
                "End Time": projectCandidate["End Time"],
                "Project Days": projectDays,
                "Project Day Mode": projectDayMode
            };
            if (
                appointment["Staff ID"] &&
                hasSchedulingConflict(updatedProject, appointments.filter((_, index) => index !== appointmentIndex))
            ) {
                return res.status(409).json({ message: "This technician is unavailable during the selected project reservation." });
            }
            Object.assign(appointment, updatedProject);
        }

        const ticketSheet = workbook.Sheets.Ticket;
        const tickets = ticketSheet ? XLSX.utils.sheet_to_json(ticketSheet) : [];
        const ticket = tickets.find(row =>
            String(row["Ticket ID"] || "") === String(appointment["Ticket ID"] || "")
        );
        if (ticket) {
            ticket["Appointment Date"] = appointment["Start Date"];
            ticket["Appointment Time"] = appointment["Start Time"];
            ticket["Appointment Address"] = appointment.Address;
            ticket["Appointment Status"] = appointment.Status;
            if (Number(appointment["Project Days"] || 0) > 0) {
                ticket["Appointment Duration"] = Number(appointment["Project Days"]);
            } else {
                ticket["Appointment Duration"] =
                    (localDateTime(appointment["End Date"], appointment["End Time"]) -
                    localDateTime(appointment["Start Date"], appointment["Start Time"])) / 3600000;
            }
            const assignee = roster.find(person =>
                String(person["Staff ID"] || "") === String(appointment["Staff ID"] || "")
            );
            ticket["Visit Technician"] = assignee ? String(assignee.Name || "") : "";
            if (
                isProjectCreditTicket(ticket) &&
                areProjectAppointmentsFinalized(appointments, ticket["Ticket ID"])
            ) {
                const reports = workbook.Sheets.ServiceReport
                    ? XLSX.utils.sheet_to_json(workbook.Sheets.ServiceReport)
                    : [];
                const settlement = settleProjectTicketCredits(
                    workbook,
                    ticket,
                    getProjectTicketBillableCredits(reports, ticket["Ticket ID"]),
                    true
                );
                if (settlement.error) {
                    return res.status(500).json({ message: settlement.error });
                }
            }
            workbook.Sheets.Ticket = XLSX.utils.json_to_sheet(tickets);
        }

        saveAppointments(workbook, appointments);
        writeWorkbook(workbook);
        return res.json({ appointment });
    } catch (error) {
        console.error("Update appointment error:", error);
        return res.status(500).json({ message: "Unable to update the appointment." });
    }
});

app.get("/api/staff/customers", requireStaffSession, (req, res) => {
    try {
        const workbook = XLSX.readFile(excelFile);
        const customerWorksheet = workbook.Sheets.Customer;
        const ticketWorksheet = workbook.Sheets.Ticket;

        if (!customerWorksheet) {
            return res.status(404).json({ message: "Customer sheet not found." });
        }
        if (!ticketWorksheet) {
            return res.status(404).json({ message: "Ticket sheet not found." });
        }

        const customersData = XLSX.utils.sheet_to_json(customerWorksheet);
        const ticketsData = XLSX.utils.sheet_to_json(ticketWorksheet);
        const entries = getCustomerDirectoryEntries(customersData, ticketsData);
        const customerList = entries.map(entry => {
            return {
                ...entry.customer,
                totalTickets: entry.ticketCounts.total
            };
        });

        return res.json(customerList);
    } catch (error) {
        console.error("Get customer directory error:", error);
        return res.status(500).json({
            message: "Unable to load the customer directory."
        });
    }
});

app.get("/api/staff/customers/:customerId", requireStaffSession, (req, res) => {
    try {
        const workbook = XLSX.readFile(excelFile);
        const customerWorksheet = workbook.Sheets.Customer;
        const ticketWorksheet = workbook.Sheets.Ticket;

        if (!customerWorksheet) {
            return res.status(404).json({ message: "Customer sheet not found." });
        }
        if (!ticketWorksheet) {
            return res.status(404).json({ message: "Ticket sheet not found." });
        }

        const customersData = XLSX.utils.sheet_to_json(customerWorksheet);
        const ticketsData = XLSX.utils.sheet_to_json(ticketWorksheet);
        const entry = getCustomerDirectoryEntries(customersData, ticketsData).find(
            row => row.customer.id === req.params.customerId
        );

        if (!entry) {
            return res.status(404).json({ message: "Customer not found." });
        }

        return res.json(entry);
    } catch (error) {
        console.error("Get customer details error:", error);
        return res.status(500).json({
            message: "Unable to load customer details."
        });
    }
});

app.patch("/api/staff/profile", requireStaffSession, (req, res) => {
    try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const name = typeof body.name === "string" ? body.name.trim() : "";
        const currentPassword = typeof body.currentPassword === "string"
            ? body.currentPassword
            : "";
        const newPassword = typeof body.newPassword === "string"
            ? body.newPassword
            : "";
        const confirmPassword = typeof body.confirmPassword === "string"
            ? body.confirmPassword
            : "";

        if (!name || name.length > 100) {
            return res.status(400).json({
                message: "Please enter a name between 1 and 100 characters."
            });
        }

        const changingPassword = Boolean(
            currentPassword || newPassword || confirmPassword
        );

        if (changingPassword) {
            if (!currentPassword || !newPassword || !confirmPassword) {
                return res.status(400).json({
                    message: "Enter your current password and the new password twice."
                });
            }

            if (newPassword.length < 8 || newPassword.length > 256) {
                return res.status(400).json({
                    message: "The new password must be between 8 and 256 characters."
                });
            }

            if (newPassword !== confirmPassword) {
                return res.status(400).json({ message: "The new passwords do not match." });
            }
        }

        const workbook = XLSX.readFile(excelFile);
        const worksheet = workbook.Sheets.Staff;

        if (!worksheet) {
            return res.status(404).json({ message: "Staff sheet not found." });
        }

        const staffData = XLSX.utils.sheet_to_json(worksheet);
        const staff = findStaffForSession(staffData, req.staffSession);

        if (!staff) {
            staffSessions.delete(getStaffSessionToken(req));
            setStaffSessionCookie(req, res, "", 0);
            return res.status(401).json({ message: "Please log in to continue." });
        }

        if (
            changingPassword &&
            !verifyStaffPassword(currentPassword, staff.Password)
        ) {
            return res.status(403).json({ message: "The current password is incorrect." });
        }

        staff.Name = name;
        if (changingPassword) {
            staff.Password = hashStaffPassword(newPassword);
        }

        workbook.Sheets.Staff = XLSX.utils.json_to_sheet(staffData);
        writeWorkbook(workbook);

        return res.json({
            message: "Profile updated successfully.",
            staff: staffProfile(staff)
        });
    } catch (error) {
        console.error("Update staff profile error:", error);
        const isLocked = error && error.code === "DATABASE_LOCKED";
        return res.status(isLocked ? 409 : 500).json({
            message: isLocked
                ? error.message
                : "Unable to update staff profile."
        });
    }
});

app.post("/api/staff/logout", (req, res) => {
    staffSessions.delete(getStaffSessionToken(req));
    setStaffSessionCookie(req, res, "", 0);
    return res.sendStatus(204);
});


/* =========================================================
   CREATE TICKET
========================================================= */

app.post("/api/tickets", (req, res) => {

    try {

        const validationMessage = validateTicketCreation(req.body);
        if (validationMessage) {
            return res.status(400).json({ message: validationMessage });
        }

        const workbook =
            XLSX.readFile(excelFile);


        /* =========================
           GET CUSTOMER DATA
        ========================= */

        const customerWorksheet =
            workbook.Sheets["Customer"];


        if (!customerWorksheet) {

            return res.status(500).json({

                message:
                    "Customer sheet not found."

            });

        }


        const customersData =
            XLSX.utils.sheet_to_json(
                customerWorksheet
            );
        const customerIndexes = createCustomerIndexes(customersData);


        const submittedCustomerId =
            req.body.customerId;

        const supportTypeValue =
            String(req.body.supportType || "").trim();

        const isOnSiteSupportRequest =
            supportTypeValue.toLowerCase() ===
            "on-site support";

        const submittedEmail =
            String(req.body.email || "").trim();

        const submittedName =
            String(req.body.customerName || "").trim();

        const matchedCustomerIndex = submittedCustomerId
            ? customerIndexes.byId.get(String(submittedCustomerId))
            : customerIndexes.byEmail.get(normalizeEmail(submittedEmail));
        const matchedCustomerHasNoName =
            matchedCustomerIndex !== undefined &&
            !String(customersData[matchedCustomerIndex].Name || "").trim();
        const needsCustomerName =
            (!submittedCustomerId && matchedCustomerIndex === undefined) ||
            matchedCustomerHasNoName;

        if (needsCustomerName && !submittedName) {
            return res.status(409).json({
                code: "CUSTOMER_NAME_REQUIRED",
                message: "A name is required to complete this customer record."
            });
        }

        const customerResolution =
            resolveCustomerForTicket(
                customersData,
                submittedCustomerId,
                submittedEmail,
                needsCustomerName ? submittedName : "",
                customerIndexes
            );


        if (customerResolution.reason) {
            return res.status(404).json({
                message: customerResolution.reason
            });
        }


        const customer =
            customerResolution.customer;

        const customerIndex =
            customerResolution.customerIndex;


        if (!customer) {
            return res.status(400).json({
                message: "Customer is required."
            });
        }


        /* =========================
           GET APPOINTMENT DURATION
        ========================= */

        let appointmentDuration = null;
        let originalAppointmentDuration = null;
        let roundedDurationNotice = null;
        let projectEstimatedHours = null;
        let projectDays = null;
        const onSiteSupportType =
            String(
                req.body.onSiteSupportType || ""
            ).trim();


        if (isOnSiteSupportRequest) {

            if (!onSiteSupportType) {

                return res.status(400).json({

                    message:
                        "Please select an on-site support type."

                });

            }

            const appointmentDate = String(req.body.appointmentDate || "").trim();
            const appointmentTime = String(req.body.appointmentTime || "").trim();
            const appointmentValidationMessage = onSiteSupportType === "Project"
                ? validateProjectBookingDate(appointmentDate)
                : validateAppointmentDateTime(appointmentDate, appointmentTime);

            if (appointmentValidationMessage) {
                return res.status(400).json({
                    message: appointmentValidationMessage
                });
            }

            const WORK_HOURS_PER_DAY = 8;
            let minimumHours = 0;

            if (onSiteSupportType === "Maintenance") {
                minimumHours = 1;
            } else if (onSiteSupportType === "Ad Hoc") {
                minimumHours = 2;
            } else if (onSiteSupportType === "Project") {
                minimumHours = 0;
            } else {
                return res.status(400).json({

                    message:
                        "Invalid on-site support type selected."

                });
            }

            if (onSiteSupportType === "Project") {
//                const rawEstimatedHours = Number(req.body.projectEstimatedHours);
                projectDays = Number(req.body.projectDays);
//                originalAppointmentDuration = rawEstimatedHours;
//                projectEstimatedHours = rawEstimatedHours;
//                appointmentDuration = projectDays;
//                if (
//                    !Number.isFinite(rawEstimatedHours) ||
//                    rawEstimatedHours <= 0 ||
//                    !Number.isFinite(projectEstimatedHours) ||
//                    projectEstimatedHours <= 0
//                ) {
//                    return res.status(400).json({
//                        message: "Project estimated work hours must be a positive number."
//                    });
//                }
//                if (!Number.isInteger(rawEstimatedHours * 2)) {
//                    return res.status(400).json({
//                        message: "Project estimated work hours must be in 0.5-hour increments."
//                    });
//                }
                if (!Number.isInteger(projectDays) || projectDays < 1) {
                    return res.status(400).json({
                        message: "Estimated Project days must be a whole number (minimum 1 day)."
                    });
                }
                projectEstimatedHours = projectDays * WORK_HOURS_PER_DAY;
                originalAppointmentDuration = projectEstimatedHours;
                appointmentDuration = projectDays;
            } else {
                originalAppointmentDuration = parseFloat(req.body.appointmentDuration);
                appointmentDuration = originalAppointmentDuration;
                if (
                    !Number.isFinite(
                        appointmentDuration
                    ) ||
                    appointmentDuration < minimumHours
                ) {

                    return res.status(400).json({

                        message:
                            `On-site Support (${onSiteSupportType}) requires a minimum duration of ${minimumHours} hour(s).`

                    });

                }


                /* =========================
                   ROUND UP TO 0.5 HOUR INCREMENTS
                ========================= */

                if (
                    !Number.isInteger(
                        appointmentDuration * 2
                    )
                ) {
                    const roundedDuration =
                        Math.ceil(
                            appointmentDuration * 2
                        ) / 2;

                    appointmentDuration = roundedDuration;
                    roundedDurationNotice =
                        `Duration was rounded up from ${originalAppointmentDuration} hour(s) to ${appointmentDuration} hour(s). This increases the credit cost to ${appointmentDuration} credit(s).`;
                }
            }

        }


        /* =========================
           GET CUSTOMER CREDITS
        ========================= */

        let currentCredits = 0;


        if (customer) {

            currentCredits =
                Number(
                    customer["Credits"] || 0
                );

        }

        const estimatedCreditsForRequest = isOnSiteSupportRequest
            ? onSiteSupportType === "Project"
                ? projectEstimatedHours
                : appointmentDuration
            : 0;

        /* =========================
           CHECK CREDITS
        ========================= */

        if (
            customer &&
            isOnSiteSupportRequest &&
            currentCredits <
            estimatedCreditsForRequest
        ) {

            return res.status(400).json({

                message:
                    "The customer only has " +
                    currentCredits +
                    " credit(s), but requested " +
                    estimatedCreditsForRequest +
                    " hour(s)."

            });

        }


        /* =========================
           DEDUCT CREDITS
        ========================= */

        let remainingCredits =
            currentCredits;


        if (
            customer &&
            isOnSiteSupportRequest &&
            estimatedCreditsForRequest > 0
        ) {

            remainingCredits =
                currentCredits -
                estimatedCreditsForRequest;


            customersData[customerIndex]["Credits"] =
                remainingCredits;

        }


        /* =========================
           SAVE CUSTOMER SHEET
        ========================= */

        workbook.Sheets["Customer"] =
            XLSX.utils.json_to_sheet(
                customersData
            );


        /* =========================
           GET TICKET DATA
        ========================= */

        const ticketWorksheet =
            workbook.Sheets["Ticket"];


        if (!ticketWorksheet) {

            return res.status(500).json({

                message:
                    "Ticket sheet not found."

            });

        }


        const ticketsData =
            XLSX.utils.sheet_to_json(
                ticketWorksheet
            );


        /* =========================
           CREATE TICKET
        ========================= */

        const ticket = {

            "Ticket ID":
                "T-" + Date.now(),

            "Customer ID":
                customer["Customer ID"] || "",

            "Customer Name":
                customer.Name || submittedName || "",

            "Email":
                customer.Email || submittedEmail || "",

            "Issue":
                req.body.issue || "",

            "Support Type":
                supportTypeValue,

            "On-site Support Type":
                isOnSiteSupportRequest
                    ? onSiteSupportType
                    : "",

            "Status":
                "Open",

            "Assigned Engineer":
                "",

            "Appointment Date":
                isOnSiteSupportRequest
                    ? req.body.appointmentDate
                    : "",

            "Appointment Time":
                isOnSiteSupportRequest
                    ? req.body.appointmentTime
                    : "",

            "Appointment Duration":
                appointmentDuration,

            "Project Estimated Hours":
                isOnSiteSupportRequest && onSiteSupportType === "Project"
                    ? projectEstimatedHours
                    : "",

            "Appointment Address":
                isOnSiteSupportRequest
                    ? String(req.body.appointmentAddress || "").trim()
                    : "",

            "Credits Charged":
                estimatedCreditsForRequest > 0
                    ? estimatedCreditsForRequest
                    : 0,

            "Billable Credits":
                isOnSiteSupportRequest && onSiteSupportType === "Project"
                    ? 0
                    : estimatedCreditsForRequest > 0
                        ? estimatedCreditsForRequest
                    : 0,

            "Unpaid Credits":
                0,

            "Credit Settlement Status":
                isOnSiteSupportRequest
                    ? "Pending"
                    : "Not Applicable",

            "Appointment Status":
                isOnSiteSupportRequest ? "Reschedule Required" : "Pending",

            "Created Date":
                new Date().toISOString(),

            "Service Result":
                ""

        };

        let assignedTechnician = null;
        let createdAppointment = null;
        let appointmentCandidate = null;
        if (isOnSiteSupportRequest) {
            const { roster } = ensureStaffRoster(workbook);
            const appointments = readAppointments(workbook);
            appointmentCandidate = getAppointmentCandidate({
                date: String(req.body.appointmentDate || "").trim(),
                time: onSiteSupportType === "Project"
                    ? "00:00"
                    : String(req.body.appointmentTime || "").trim(),
                durationHours: onSiteSupportType === "Project" ? null : appointmentDuration,
                projectDays: onSiteSupportType === "Project" ? projectDays : 0,
                projectDayMode: String(req.body.projectDayMode || "calendar").trim(),
                address: String(req.body.appointmentAddress || "").trim(),
                ticketId: ticket["Ticket ID"]
            });

            if (!appointmentCandidate) {
                return res.status(400).json({
                    message: "The requested appointment schedule is invalid."
                });
            }

            assignedTechnician = chooseTechnician(
                roster.filter(getStaffRoleEligibility),
                appointments,
                appointmentCandidate,
                ["Technician", "Engineer", "IT Support Staff"]
            );
            createdAppointment = buildAppointmentRecord(
                appointmentCandidate,
                `A-${crypto.randomUUID()}`,
                assignedTechnician ? String(assignedTechnician["Staff ID"]) : "",
                assignedTechnician
                    ? ""
                    : "No eligible technician is available for this requested time. Scheduling follow-up is required."
            );
            appointments.push(createdAppointment);
            saveAppointments(workbook, appointments);
            ticket["Appointment Status"] = createdAppointment.Status;
            if (assignedTechnician) {
                ticket["Visit Technician"] = String(assignedTechnician.Name || "");
            }
        }

        /* =========================
           ADD TICKET
        ========================= */

        ticketsData.push(ticket);


        /* =========================
           SAVE TICKET SHEET
        ========================= */

        workbook.Sheets["Ticket"] =
            XLSX.utils.json_to_sheet(
                ticketsData
            );


        /* =========================
           SAVE EXCEL FILE
        ========================= */

        if (createdAppointment) {
            writeWorkbook(workbook, () => {
                const latestWorkbook = XLSX.readFile(excelFile);
                const latestRoster = ensureStaffRoster(latestWorkbook).roster;
                const latestAppointments = readAppointments(latestWorkbook);
                assignedTechnician = chooseTechnician(
                    latestRoster.filter(getStaffRoleEligibility),
                    latestAppointments,
                    appointmentCandidate,
                    ["Technician", "Engineer", "IT Support Staff"]
                );
                createdAppointment["Staff ID"] = assignedTechnician
                    ? String(assignedTechnician["Staff ID"])
                    : "";
                createdAppointment.Status = assignedTechnician ? "Pending" : "Reschedule Required";
                createdAppointment["Scheduling Note"] = assignedTechnician
                    ? ""
                    : "No eligible technician is available for this requested time. Scheduling follow-up is required.";
                const latestRosterSheet = XLSX.utils.json_to_sheet(
                    latestRoster,
                    { header: STAFF_ROSTER_COLUMNS }
                );
                setWorkbookSheet(workbook, "StaffRoster", latestRosterSheet);
                saveAppointments(workbook, latestAppointments.concat(createdAppointment));
                ticket["Appointment Status"] = createdAppointment.Status;
                ticket["Visit Technician"] = assignedTechnician
                    ? String(assignedTechnician.Name || "")
                    : "";
                workbook.Sheets["Ticket"] = XLSX.utils.json_to_sheet(ticketsData);
            });
        } else {
            writeWorkbook(workbook);
        }

        console.log(
            "New ticket saved to Excel:",
            ticket
        );


        console.log(
            "Customer credits:",
            currentCredits,
            "->",
            remainingCredits
        );


        /* =========================
           SEND RESPONSE
        ========================= */

        res.status(201).json({

            message:
                roundedDurationNotice ||
                "Ticket created successfully.",

            ticketId:
                ticket["Ticket ID"],

            remainingCredits:
                remainingCredits,

            originalDuration:
                originalAppointmentDuration || null,

            roundedDuration:
                appointmentDuration,

            roundUpApplied:
                !!roundedDurationNotice,

            technician:
                assignedTechnician
                    ? String(assignedTechnician.Name || "")
                    : null,

            appointmentStatus:
                createdAppointment ? createdAppointment.Status : null,

            schedulingNote:
                createdAppointment ? createdAppointment["Scheduling Note"] : null

        });

    } catch (error) {
        if (error && error.code === "DATABASE_LOCKED") {
            return res.status(409).json({ message: error.message });
        }

        console.error(
            "Create ticket error:",
            error
        );

        res.status(500).json({

            message:
                "Unable to create ticket."

        });

    }

});

/* =========================================================
   GET ALL TICKETS
========================================================= */

app.get("/api/tickets", (req, res) => {

    if (req.query.customerId) {
        return res.status(410).json({
            message: "Customer ticket access is currently disabled."
        });
    }

    try {

        const customerId =
            req.query.customerId;


        const workbook =
            XLSX.readFile(excelFile);


        const worksheet =
            workbook.Sheets["Ticket"];


        if (!worksheet) {

            return res.json([]);

        }


        const ticketsData =
            XLSX.utils.sheet_to_json(
                worksheet
            );


        /* =========================
           CUSTOMER VIEW
        ========================= */

        if (customerId) {

            const customerTickets =
                ticketsData.filter(
                    ticket =>
                        ticket["Customer ID"] ===
                        customerId
                );


            return res.json(
                customerTickets
            );

        }


        /* =========================
           STAFF VIEW
        ========================= */

        res.json(
            ticketsData
        );

    } catch (error) {

        console.error(
            "Get tickets error:",
            error
        );

        res.status(500).json({

            message:
                "Unable to load tickets."

        });

    }

});


/* =========================================================
   GET SINGLE TICKET
========================================================= */

app.get(
    "/api/tickets/:ticketId",
    (req, res) => {

        try {

            const ticketId =
                req.params.ticketId;


            const workbook =
                XLSX.readFile(
                    excelFile
                );


            const worksheet =
                workbook.Sheets["Ticket"];


            if (!worksheet) {

                return res.status(404).json({

                    message:
                        "Ticket sheet not found."

                });

            }


            const ticketsData =
                XLSX.utils.sheet_to_json(
                    worksheet
                );


            const ticket =
                ticketsData.find(
                    ticket =>
                        ticket["Ticket ID"] ===
                        ticketId
                );


            if (!ticket) {

                return res.status(404).json({

                    message:
                        "Ticket not found."

                });

            }


            res.json(ticket);

        } catch (error) {

            console.error(
                "Get single ticket error:",
                error
            );

            res.status(500).json({

                message:
                    "Unable to load ticket."

            });

        }

    }
);


/* =========================================================
   UPDATE TICKET
========================================================= */

app.put(
    "/api/tickets/:ticketId",
    (req, res) => {

        try {

            const validationMessage = validateTicketUpdate(req.body);
            if (validationMessage) {
                return res.status(400).json({ message: validationMessage });
            }

            const ticketId =
                req.params.ticketId;


            const workbook =
                XLSX.readFile(
                    excelFile
                );


            const worksheet =
                workbook.Sheets["Ticket"];


            if (!worksheet) {

                return res.status(404).json({

                    message:
                        "Ticket sheet not found."

                });

            }


            const ticketsData =
                XLSX.utils.sheet_to_json(
                    worksheet
                );


            /* =========================
               FIND TICKET
            ========================= */

            const ticketIndex =
                ticketsData.findIndex(
                    ticket =>
                        ticket["Ticket ID"] ===
                        ticketId
                );


            if (ticketIndex === -1) {

                return res.status(404).json({

                    message:
                        "Ticket not found."

                });

            }


            const currentTicket =
                ticketsData[ticketIndex];

            const customerRecordToUse =
                currentTicket["Customer ID"] ||
                req.body.customerId ||
                "";

            const customerEmailToUse =
                String(
                    req.body.email ||
                    currentTicket["Email"] ||
                    ""
                ).trim();

            const customerNameToUse =
                String(
                    req.body.customerName ||
                    currentTicket["Customer Name"] ||
                    ""
                ).trim();

            const customerWorksheet =
                workbook.Sheets["Customer"];

            if (!customerWorksheet) {
                return res.status(500).json({
                    message: "Customer sheet not found."
                });
            }

            const customersData =
                XLSX.utils.sheet_to_json(
                    customerWorksheet
                );
            const customerIndexes = createCustomerIndexes(customersData);

            let resolvedCustomer = null;
            let customerResolution = null;

            if (customerRecordToUse || customerEmailToUse) {
                customerResolution =
                    resolveCustomerForTicket(
                        customersData,
                        customerRecordToUse,
                        customerEmailToUse,
                        customerNameToUse,
                        customerIndexes
                    );

                resolvedCustomer = customerResolution.customer;

                if (customerResolution.created) {
                    workbook.Sheets["Customer"] =
                        XLSX.utils.json_to_sheet(customersData);
                }
            }

            if (resolvedCustomer) {
                currentTicket["Customer ID"] =
                    resolvedCustomer["Customer ID"] || "";

                currentTicket["Customer Name"] =
                    resolvedCustomer.Name || customerNameToUse || "";

                currentTicket["Email"] =
                    resolvedCustomer.Email || customerEmailToUse || "";
            }

            /* =========================
               UPDATE TICKET
            ========================= */

            const currentRoster = ensureStaffRoster(workbook).roster;
            const assignedEngineerName = String(req.body.assignedEngineer || "").trim();
            const assignedStaffRecord = currentRoster.find(person =>
                String(person.Name || "").trim() === assignedEngineerName &&
                String(person.Active || "Yes").toLowerCase() !== "no"
            );

            ticketsData[ticketIndex][
                "Assigned Engineer"
            ] =
                assignedEngineerName;
            ticketsData[ticketIndex]["Assigned Staff ID"] =
                assignedStaffRecord ? String(assignedStaffRecord["Staff ID"] || "") : "";


            ticketsData[ticketIndex][
                "Status"
            ] =
                req.body.status || "Open";


            ticketsData[ticketIndex][
                "Appointment Status"
            ] =
                req.body.appointmentStatus ||
                "Pending";


            ticketsData[ticketIndex][
                "Service Result"
            ] =
                req.body.serviceResult || "";


            if (customerResolution && customerResolution.created) {
                workbook.Sheets["Customer"] =
                    XLSX.utils.json_to_sheet(customersData);
            }

            /* =========================
               SAVE
            ========================= */

            workbook.Sheets["Ticket"] =
                XLSX.utils.json_to_sheet(
                    ticketsData
                );


            writeWorkbook(workbook);

            console.log(
                "Ticket updated:",
                ticketId
            );


            res.json({

                message:
                    "Ticket updated successfully."

            });

        } catch (error) {

            console.error(
                "Update ticket error:",
                error
            );

                if (error && error.code === "DATABASE_LOCKED") {
                    return res.status(409).json({
                        message: error.message
                    });
                }

                return res.status(500).json({
                    message: "Unable to update ticket."
                });

        }

    }
);


/* =========================================================
   DELETE TICKET
========================================================= */

app.delete(
    "/api/tickets/:ticketId",
    requireStaffSession,
    (req, res) => {

        try {

            const ticketId =
                req.params.ticketId;


            const workbook =
                XLSX.readFile(
                    excelFile
                );


            const worksheet =
                workbook.Sheets["Ticket"];


            if (!worksheet) {

                return res.status(404).json({

                    message:
                        "Ticket sheet not found."

                });

            }


            const ticketsData =
                XLSX.utils.sheet_to_json(
                    worksheet
                );


            /* =========================
               FIND TICKET
            ========================= */

            const ticketIndex =
                ticketsData.findIndex(
                    ticket =>
                        ticket["Ticket ID"] ===
                        ticketId
                );


            if (ticketIndex === -1) {

                return res.status(404).json({

                    message:
                        "Ticket not found."

                });

            }

            const ticketToDelete =
                ticketsData[ticketIndex];

            let refundApplied = false;
            let refundedCredits = 0;
            const ticketReports = workbook.Sheets["ServiceReport"]
                ? XLSX.utils.sheet_to_json(workbook.Sheets["ServiceReport"])
                    .filter(report => String(report["Ticket ID"] || "").trim() === ticketId)
                : [];
            const hasServiceReport = ticketReports.length > 0;
            const settlementStatus = String(
                ticketToDelete["Credit Settlement Status"] || ""
            ).trim();
            const shouldRefundEstimate =
                isCreditBillableTicket(ticketToDelete) &&
                !isProjectCreditTicket(ticketToDelete) &&
                !hasServiceReport &&
                settlementStatus !== "Settled";

            if (isProjectCreditTicket(ticketToDelete)) {
                const projectSettlement = settleProjectTicketCredits(
                    workbook,
                    ticketToDelete,
                    getProjectTicketBillableCredits(ticketReports, ticketId),
                    true
                );
                if (projectSettlement.error) {
                    return res.status(500).json({
                        message: `${projectSettlement.error} Unable to delete ticket.`
                    });
                }
                refundedCredits = projectSettlement.refundedCredits;
                refundApplied = refundedCredits > 0;
            }

            if (shouldRefundEstimate) {
                const estimatedCredits = Number(
                    ticketToDelete["Credits Charged"] === undefined ||
                    ticketToDelete["Credits Charged"] === ""
                        ? getTicketEstimatedCredits(ticketToDelete)
                        : ticketToDelete["Credits Charged"]
                );

                if (!Number.isFinite(estimatedCredits) || estimatedCredits < 0) {
                    return res.status(500).json({
                        message: "Ticket credit information is invalid; unable to delete ticket."
                    });
                }

                if (estimatedCredits > 0) {
                    const customerWorksheet =
                        workbook.Sheets["Customer"];

                    if (!customerWorksheet) {
                        return res.status(500).json({
                            message: "Customer sheet not found; unable to refund ticket credits."
                        });
                    }

                    const customersData = XLSX.utils.sheet_to_json(customerWorksheet);
                    const customerIndex = findTicketCustomer(customersData, ticketToDelete);
                    if (customerIndex === -1) {
                        return res.status(500).json({
                            message: "Customer not found; unable to refund ticket credits."
                        });
                    }

                    const currentCredits = Number(customersData[customerIndex].Credits || 0);
                    if (!Number.isFinite(currentCredits)) {
                        return res.status(500).json({
                            message: "Customer credit balance is invalid; unable to refund ticket credits."
                        });
                    }

                    refundedCredits = estimatedCredits;
                    customersData[customerIndex].Credits = currentCredits + refundedCredits;
                    workbook.Sheets["Customer"] = XLSX.utils.json_to_sheet(customersData);
                    refundApplied = true;
                }
            }


            /* =========================
               DELETE TICKET
            ========================= */

            ticketsData.splice(
                ticketIndex,
                1
            );


            workbook.Sheets["Ticket"] =
                XLSX.utils.json_to_sheet(
                    ticketsData
                );


            writeWorkbook(workbook);

            console.log(
                "Ticket deleted:",
                ticketId,
                "Refund applied:",
                refundApplied,
                "Amount:",
                refundedCredits
            );

            res.json({

                message:
                    refundApplied
                        ? `Ticket deleted successfully. Customer refunded ${refundedCredits} credit(s).`
                        : "Ticket deleted successfully.",

                refundApplied,
                refundedCredits

            });

        } catch (error) {

            console.error(
                "Delete ticket error:",
                error
            );

            res.status(500).json({

                message:
                    "Unable to delete ticket."

            });

        }

    }
);


/* =========================================================
   GET STAFF
========================================================= */

app.get("/api/staff", requireStaffSession, (req, res) => {

    try {

        const workbook =
            XLSX.readFile(
                excelFile
            );

        const { roster, changed } = ensureStaffRoster(workbook);
        const staffList = roster
            .filter(staff =>
                String(staff.Active || "Yes").toLowerCase() !== "no" &&
                getStaffRoleEligibility(staff)
            )
            .map(staff => ({
                staffId: staff["Staff ID"],
                name: staff.Name,
                email: staff.Email,
                role: staff.Role,
                department: staff.Department
            }));
        if (changed) {
            writeWorkbook(workbook);
        }

        res.json(staffList);

    } catch (error) {

        console.error(
            "Get staff error:",
            error
        );

        res.status(500).json({

            message:
                "Unable to load staff."

        });

    }

});


/* =========================================================
   SUBMIT SERVICE REPORT
========================================================= */

function getServiceReportDurationMs(signInTime, signOutTime) {
    if (!signInTime || !signOutTime) {
        return 0;
    }

    const start = new Date(`1970-01-01T${signInTime}:00`);
    const end = new Date(`1970-01-01T${signOutTime}:00`);
    let diffMs = end - start;

    if (diffMs < 0) {
        diffMs += 24 * 60 * 60 * 1000;
    }

    return diffMs;
}

function calculateServiceReportHours(signInTime, signOutTime) {
    const durationMs = getServiceReportDurationMs(signInTime, signOutTime);
    return +(durationMs / (1000 * 60 * 60)).toFixed(2);
}

function calculateBillableServiceReportCredits(signInTime, signOutTime) {
    const durationMs = getServiceReportDurationMs(signInTime, signOutTime);
    return Math.ceil(durationMs / (30 * 60 * 1000)) / 2;
}

function normalizeServiceMode(mode, legacyOnsite) {
    const rawValue = String(mode || legacyOnsite || "").trim();
    const lowerValue = rawValue.toLowerCase();

    if (["on-site", "onsite", "on site", "yes", "visit", "on-site visit"].includes(lowerValue)) {
        return "On-site";
    }

    if (["remote", "remote support", "off-site", "offsite", "no"].includes(lowerValue)) {
        return "Remote";
    }

    if (["hybrid", "hybrid support"].includes(lowerValue)) {
        return "Hybrid";
    }

    return legacyOnsite === true ? "On-site" : "Remote";
}

function buildServiceReportFromTicket(ticket, overrides = {}) {
    const {
        onsite,
        serviceMode,
        engineer,
        date,
        signInTime,
        signOutTime,
        tasksDone,
        resolution
    } = overrides;

    const hoursSpent = calculateServiceReportHours(signInTime, signOutTime);
    const resolvedServiceMode = normalizeServiceMode(serviceMode, onsite);
    const onsiteIndicator = ["On-site", "Hybrid"].includes(resolvedServiceMode) ? "Yes" : "No";

    return {
        "Report ID": "SR-" + Date.now(),
        "Ticket ID": ticket["Ticket ID"],
        "Customer ID": ticket["Customer ID"] || "",
        "Customer Name": ticket["Customer Name"] || "",
        "Engineer": engineer || ticket["Assigned Engineer"] || "",
        "ServiceMode": resolvedServiceMode,
        "Onsite": onsiteIndicator,
        "Date": date || new Date().toISOString().split("T")[0],
        "SignInTime": signInTime || "",
        "SignOutTime": signOutTime || "",
        "HoursSpent": hoursSpent,
        "Billable Credits": calculateBillableServiceReportCredits(signInTime, signOutTime),
        "TasksDone": tasksDone || "",
        "Resolution": resolution || "",
        "Created At": new Date().toISOString()
    };
}

function setWorkbookSheet(workbook, sheetName, worksheet) {
    if (workbook.SheetNames.includes(sheetName)) {
        workbook.Sheets[sheetName] = worksheet;
        return;
    }
    XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
}

const STAFF_ROSTER_COLUMNS = [
        "Staff ID",
        "Name",
        "Role",
        "Department",
        "Email",
        "Phone",
        "Active",
        "Login Staff ID"
    ];
const APPOINTMENT_COLUMNS = [
        "Appointment ID",
        "Ticket ID",
        "Staff ID",
        "Start Date",
        "Start Time",
        "End Date",
        "End Time",
        "Actual Start Date",
        "Actual Start Time",
        "Actual End Date",
        "Actual End Time",
        "Project Days",
        "Project Day Mode",
        "Service Sessions",
        "Project Complete",
        "Address",
        "Status",
        "Scheduling Note",
        "Service Report ID",
        "Created At"
    ];

function ensureStaffRoster(workbook) {
        let roster = workbook.Sheets.StaffRoster
            ? XLSX.utils.sheet_to_json(workbook.Sheets.StaffRoster)
            : [];
        const accountStaff = workbook.Sheets.Staff
            ? XLSX.utils.sheet_to_json(workbook.Sheets.Staff)
            : [];
        let changed = !workbook.Sheets.StaffRoster;

        accountStaff.forEach(account => {
            const loginId = String(account["Staff ID"] || "").trim();
            const email = normalizeEmail(account.Email);
            const matchingRosterRecord = roster.find(person =>
                (loginId && String(person["Login Staff ID"] || "") === loginId) ||
                (email && normalizeEmail(person.Email) === email)
            );
            if (matchingRosterRecord) {
                if (loginId && !String(matchingRosterRecord["Login Staff ID"] || "")) {
                    matchingRosterRecord["Login Staff ID"] = loginId;
                    changed = true;
                }
                return;
            }

            roster.push({
                "Staff ID": loginId || `R-${crypto.randomUUID()}`,
                Name: String(account.Name || "").trim(),
                Role: String(account.Role || "").trim(),
                Department: String(account.Department || "").trim(),
                Email: String(account.Email || "").trim(),
                Phone: String(account.Phone || "").trim(),
                Active: "Yes",
                "Login Staff ID": loginId
            });
            changed = true;
        });

        if (changed) {
            setWorkbookSheet(
                workbook,
                "StaffRoster",
                XLSX.utils.json_to_sheet(roster, { header: STAFF_ROSTER_COLUMNS })
            );
        }
        return { roster, changed };
}

function readAppointments(workbook) {
        if (!workbook.Sheets.Appointment) {
            return [];
        }
        return XLSX.utils.sheet_to_json(workbook.Sheets.Appointment);
}

function saveAppointments(workbook, appointments) {
        setWorkbookSheet(
            workbook,
            "Appointment",
            XLSX.utils.json_to_sheet(appointments, { header: APPOINTMENT_COLUMNS })
        );
}

function getStaffRoleEligibility(staff) {
        return ["technician", "engineer", "it support staff"].includes(
            String(staff.Role || "").trim().toLowerCase()
        );
}

function buildAppointmentRecord(candidate, appointmentId, staffId, schedulingNote = "") {
        return {
            "Appointment ID": appointmentId,
            "Ticket ID": candidate["Ticket ID"],
            "Staff ID": staffId || "",
            "Start Date": candidate["Start Date"],
            "Start Time": candidate["Start Time"],
            "End Date": candidate["End Date"],
            "End Time": candidate["End Time"],
            "Actual Start Date": "",
            "Actual Start Time": "",
            "Actual End Date": "",
            "Actual End Time": "",
            "Project Days": candidate["Project Days"] || 0,
            "Project Day Mode": candidate["Project Day Mode"] || "",
            "Service Sessions": "[]",
            "Project Complete": "No",
            Address: candidate.Address,
            Status: staffId ? "Pending" : "Reschedule Required",
            "Scheduling Note": schedulingNote,
            "Service Report ID": "",
            "Created At": new Date().toISOString()
        };
}

function getActualSessionFromReport(report) {
        const date = String(report.Date || "");
        const signInTime = String(report.SignInTime || "");
        const signOutTime = String(report.SignOutTime || "");
        const start = localDateTime(date, signInTime);
        let end = localDateTime(date, signOutTime);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            return null;
        }
        if (end <= start) {
            end += 24 * 60 * 60 * 1000;
        }
        const endDate = new Date(end);
        return {
            date,
            signInTime,
            endDate: [
                endDate.getFullYear(),
                String(endDate.getMonth() + 1).padStart(2, "0"),
                String(endDate.getDate()).padStart(2, "0")
            ].join("-"),
            signOutTime: `${String(endDate.getHours()).padStart(2, "0")}:${String(endDate.getMinutes()).padStart(2, "0")}`,
            reportId: String(report["Report ID"] || ""),
            projectComplete: report["Project Complete"] === "Yes",
            start,
            end
        };
}

function syncProjectAppointmentFromReports(appointment, reports) {
        const sessions = reports
            .filter(report =>
                String(report["Appointment ID"] || "") === String(appointment["Appointment ID"] || "")
            )
            .map(getActualSessionFromReport)
            .filter(Boolean);
        const completedSession = sessions.find(session => session.projectComplete);
        appointment["Service Sessions"] = JSON.stringify(sessions.map(session => ({
            date: session.date,
            signInTime: session.signInTime,
            endDate: session.endDate,
            signOutTime: session.signOutTime
        })));
        appointment["Service Report ID"] = sessions.length
            ? sessions[sessions.length - 1].reportId
            : "";
        appointment["Project Complete"] = completedSession ? "Yes" : "No";
        appointment.Status = completedSession
            ? "Completed"
            : appointment["Staff ID"] ? "Pending" : "Reschedule Required";
        if (completedSession) {
            appointment["Actual Start Date"] = completedSession.date;
            appointment["Actual Start Time"] = completedSession.signInTime;
            appointment["Actual End Date"] = completedSession.endDate;
            appointment["Actual End Time"] = completedSession.signOutTime;
        } else {
            appointment["Actual Start Date"] = "";
            appointment["Actual Start Time"] = "";
            appointment["Actual End Date"] = "";
            appointment["Actual End Time"] = "";
        }
        return sessions;
}

function flagVisitsConflictingWithCompletedAppointment(workbook, appointments, completedIndex) {
    const completed = appointments[completedIndex];
    if (!completed || !completed["Staff ID"]) {
        return;
    }

    let sessions = [];
    if (Number(completed["Project Days"] || 0) > 0) {
        try {
            sessions = JSON.parse(String(completed["Service Sessions"] || "[]"));
        } catch (error) {
            throw new Error("Stored Project service sessions are invalid.", { cause: error });
        }
        if (!Array.isArray(sessions)) {
            throw new Error("Stored Project service sessions must be a list.");
        }
    } else {
        const interval = appointmentInterval(completed, true);
        if (interval) {
            sessions = [{
                date: new Date(interval.start).getFullYear() + "-" +
                    String(new Date(interval.start).getMonth() + 1).padStart(2, "0") + "-" +
                    String(new Date(interval.start).getDate()).padStart(2, "0"),
                signInTime: `${String(new Date(interval.start).getHours()).padStart(2, "0")}:${String(new Date(interval.start).getMinutes()).padStart(2, "0")}`,
                endDate: new Date(interval.end).getFullYear() + "-" +
                    String(new Date(interval.end).getMonth() + 1).padStart(2, "0") + "-" +
                    String(new Date(interval.end).getDate()).padStart(2, "0"),
                signOutTime: `${String(new Date(interval.end).getHours()).padStart(2, "0")}:${String(new Date(interval.end).getMinutes()).padStart(2, "0")}`
            }];
        }
    }

    let changed = false;
    const tickets = workbook.Sheets.Ticket
        ? XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        : [];
    sessions.forEach(session => {
        const start = localDateTime(session.date, session.signInTime);
        const end = localDateTime(session.endDate || session.date, session.signOutTime);
        if (!Number.isFinite(start) || !Number.isFinite(end)) {
            return;
        }
        const actualSession = {
            "Appointment ID": `${completed["Appointment ID"]}-session`,
            "Ticket ID": completed["Ticket ID"],
            "Staff ID": completed["Staff ID"],
            "Start Date": session.date,
            "Start Time": session.signInTime,
            "End Date": session.endDate || session.date,
            "End Time": session.signOutTime,
            "Project Days": 0,
            Status: "Completed"
        };
        appointments.forEach((appointment, index) => {
            if (
                index === completedIndex ||
                String(appointment["Staff ID"] || "") !== String(completed["Staff ID"]) ||
                !["Pending", "Confirmed"].includes(String(appointment.Status || ""))
            ) {
                return;
            }
            const interval = appointmentInterval(appointment, false);
            if (
                !interval ||
                interval.start < start ||
                !hasSchedulingConflict(appointment, [actualSession])
            ) {
                return;
            }
            appointment["Staff ID"] = "";
            appointment.Status = "Reschedule Required";
            appointment["Scheduling Note"] =
                "The technician's completed service session conflicts with this booking. Rescheduling is required.";
            const ticket = tickets.find(row =>
                String(row["Ticket ID"] || "") === String(appointment["Ticket ID"] || "")
            );
            if (ticket) {
                ticket["Appointment Status"] = "Reschedule Required";
                ticket["Visit Technician"] = "";
            }
            changed = true;
        });
    });

    if (changed) {
        workbook.Sheets.Ticket = XLSX.utils.json_to_sheet(tickets);
    }
}

function flagVisitsConflictingWithAppointmentReservation(workbook, appointments, reservationIndex) {
    const reservation = appointments[reservationIndex];
    if (
        !reservation ||
        !reservation["Staff ID"] ||
        !["Pending", "Confirmed"].includes(String(reservation.Status || ""))
    ) {
        return;
    }

    const tickets = workbook.Sheets.Ticket
        ? XLSX.utils.sheet_to_json(workbook.Sheets.Ticket)
        : [];
    let changed = false;
    appointments.forEach((appointment, index) => {
        if (
            index === reservationIndex ||
            String(appointment["Staff ID"] || "") !== String(reservation["Staff ID"]) ||
            !["Pending", "Confirmed"].includes(String(appointment.Status || "")) ||
            !hasSchedulingConflict(appointment, [reservation])
        ) {
            return;
        }

        appointment["Staff ID"] = "";
        appointment.Status = "Reschedule Required";
        appointment["Scheduling Note"] =
            "The technician's Project reservation conflicts with this booking. Rescheduling is required.";
        const ticket = tickets.find(row =>
            String(row["Ticket ID"] || "") === String(appointment["Ticket ID"] || "")
        );
        if (ticket) {
            ticket["Appointment Status"] = "Reschedule Required";
            ticket["Visit Technician"] = "";
        }
        changed = true;
    });

    if (changed) {
        workbook.Sheets.Ticket = XLSX.utils.json_to_sheet(tickets);
    }
}

app.get(
    "/api/tickets/:ticketId/appointments",
    requireStaffSession,
    (req, res) => {
        try {
            const workbook = XLSX.readFile(excelFile);
            const ticketSheet = workbook.Sheets.Ticket;
            if (!ticketSheet) {
                return res.status(404).json({ message: "Ticket sheet not found." });
            }
            const tickets = XLSX.utils.sheet_to_json(ticketSheet);
            if (!tickets.some(ticket => String(ticket["Ticket ID"] || "") === req.params.ticketId)) {
                return res.status(404).json({ message: "Ticket not found." });
            }
            const { roster } = ensureStaffRoster(workbook);
            const appointments = readAppointments(workbook)
                .filter(appointment =>
                String(appointment["Ticket ID"] || "") === req.params.ticketId
                )
                .map(appointment => ({
                    ...appointment,
                    technicianName: String(
                        roster.find(person =>
                            String(person["Staff ID"] || "") === String(appointment["Staff ID"] || "")
                        )?.Name || ""
                    )
                }));
            return res.json(appointments);
        } catch (error) {
            console.error("Get ticket appointments error:", error);
            return res.status(500).json({ message: "Unable to load ticket appointments." });
        }
    }
);

app.post("/api/staff/tickets/:ticketId/appointments", requireStaffSession, (req, res) => {
    try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const address = typeof body.address === "string" ? body.address.trim() : "";
        const date = typeof body.date === "string" ? body.date.trim() : "";
        const time = typeof body.time === "string" ? body.time.trim() : "";
        const projectDays = Number(body.projectDays || 0);
        const durationHours = Number(body.durationHours || 0);
        const projectDayMode = body.projectDayMode || "";
        const requestedStaffId = typeof body.staffId === "string" ? body.staffId.trim() : "";
        if (!address || address.length > 500) {
            return res.status(400).json({ message: "Provide a visit address of at most 500 characters." });
        }
        if (
            (projectDays > 0 && (!Number.isInteger(projectDays) || !["calendar", "weekdays"].includes(projectDayMode))) ||
            (projectDays <= 0 && (!Number.isFinite(durationHours) || durationHours <= 0))
        ) {
            return res.status(400).json({ message: "Provide a valid appointment duration or Project day reservation." });
        }
        const dateValidation = projectDays > 0
            ? validateProjectBookingDate(date)
            : validateAppointmentDateTime(date, time);
        if (dateValidation) {
            return res.status(400).json({ message: dateValidation });
        }

        const workbook = XLSX.readFile(excelFile);
        const ticketSheet = workbook.Sheets.Ticket;
        if (!ticketSheet) return res.status(404).json({ message: "Ticket sheet not found." });
        const tickets = XLSX.utils.sheet_to_json(ticketSheet);
        const ticket = tickets.find(row =>
            String(row["Ticket ID"] || "") === req.params.ticketId
        );
        if (!ticket) {
            return res.status(404).json({ message: "Ticket not found." });
        }
        const { roster } = ensureStaffRoster(workbook);
        const appointments = readAppointments(workbook);
        let requestedTechnician = null;
        if (requestedStaffId) {
            requestedTechnician = roster.find(person =>
                String(person["Staff ID"] || "") === requestedStaffId
            );
            if (
                !requestedTechnician ||
                String(requestedTechnician.Active || "Yes").toLowerCase() === "no" ||
                !getStaffRoleEligibility(requestedTechnician)
            ) {
                return res.status(400).json({ message: "Choose an active technician eligible for appointments." });
            }
            const assignedStaffId = String(ticket["Assigned Staff ID"] || "").trim();
            const legacyAssignee = String(ticket["Assigned Engineer"] || "").trim().toLowerCase();
            if (
                (assignedStaffId && assignedStaffId !== requestedStaffId) ||
                (!assignedStaffId && legacyAssignee !== String(requestedTechnician.Name || "").trim().toLowerCase())
            ) {
                return res.status(400).json({ message: "Choose a ticket assigned to this staff member." });
            }
        }
        const candidate = getAppointmentCandidate({
            date,
            time,
            durationHours: projectDays ? null : durationHours,
            projectDays,
            projectDayMode,
            address,
            ticketId: req.params.ticketId
        });
        if (!candidate) return res.status(400).json({ message: "Provide a valid appointment date and time." });

        let technician = requestedStaffId
            ? requestedTechnician
            : chooseTechnician(
                roster.filter(getStaffRoleEligibility),
                appointments,
                candidate,
                ["Technician", "Engineer", "IT Support Staff"]
            );
        if (
            technician &&
            hasSchedulingConflict(
                { ...candidate, "Staff ID": String(technician["Staff ID"]) },
                appointments
            )
        ) {
            return res.status(409).json({ message: "This technician is unavailable at the requested time or travel buffer." });
        }
        if (requestedStaffId && !technician) {
            return res.status(400).json({ message: "Choose an active technician eligible for appointments." });
        }
        const appointment = buildAppointmentRecord(
            candidate,
            `A-${crypto.randomUUID()}`,
            technician ? String(technician["Staff ID"]) : "",
            technician ? "" : "No eligible technician is available for this requested time. Scheduling follow-up is required."
        );
        writeWorkbook(workbook, () => {
            const latestWorkbook = XLSX.readFile(excelFile);
            const latestRoster = ensureStaffRoster(latestWorkbook).roster;
            const latestAppointments = readAppointments(latestWorkbook);
            if (requestedStaffId) {
                const latestTickets = latestWorkbook.Sheets.Ticket
                    ? XLSX.utils.sheet_to_json(latestWorkbook.Sheets.Ticket)
                    : [];
                const latestTicket = latestTickets.find(row =>
                    String(row["Ticket ID"] || "") === req.params.ticketId
                );
                technician = latestRoster.find(person =>
                    String(person["Staff ID"] || "") === requestedStaffId &&
                    String(person.Active || "Yes").toLowerCase() !== "no" &&
                    getStaffRoleEligibility(person)
                );
                if (!technician) {
                    const error = new Error("Choose an active technician eligible for appointments.");
                    error.code = "INVALID_APPOINTMENT_STAFF";
                    throw error;
                }
                const latestAssignedStaffId = String(latestTicket?.["Assigned Staff ID"] || "").trim();
                const latestLegacyAssignee = String(latestTicket?.["Assigned Engineer"] || "").trim().toLowerCase();
                if (
                    !latestTicket ||
                    (latestAssignedStaffId && latestAssignedStaffId !== requestedStaffId) ||
                    (!latestAssignedStaffId && latestLegacyAssignee !== String(technician.Name || "").trim().toLowerCase())
                ) {
                    const error = new Error("Choose a ticket assigned to this staff member.");
                    error.code = "APPOINTMENT_TICKET_ASSIGNMENT";
                    throw error;
                }
                if (
                    hasSchedulingConflict(
                        { ...candidate, "Staff ID": String(technician["Staff ID"]) },
                        latestAppointments
                    )
                ) {
                    const error = new Error("This technician is unavailable at the requested time or travel buffer.");
                    error.code = "APPOINTMENT_CONFLICT";
                    throw error;
                }
            } else {
                technician = chooseTechnician(
                    latestRoster.filter(getStaffRoleEligibility),
                    latestAppointments,
                    candidate,
                    ["Technician", "Engineer", "IT Support Staff"]
                );
            }
            appointment["Staff ID"] = technician ? String(technician["Staff ID"]) : "";
            appointment.Status = technician ? "Pending" : "Reschedule Required";
            appointment["Scheduling Note"] = technician
                ? ""
                : "No eligible technician is available for this requested time. Scheduling follow-up is required.";
            setWorkbookSheet(
                workbook,
                "StaffRoster",
                XLSX.utils.json_to_sheet(latestRoster, { header: STAFF_ROSTER_COLUMNS })
            );
            if (latestWorkbook.Sheets.Ticket) {
                workbook.Sheets.Ticket = latestWorkbook.Sheets.Ticket;
            }
            saveAppointments(workbook, latestAppointments.concat(appointment));
        });
        return res.status(201).json({ appointment, technician: technician ? String(technician.Name || "") : null });
    } catch (error) {
        if (error && error.code === "DATABASE_LOCKED") {
            return res.status(409).json({ message: error.message });
        }
        if (error && error.code === "APPOINTMENT_CONFLICT") {
            return res.status(409).json({ message: error.message });
        }
        if (error && error.code === "INVALID_APPOINTMENT_STAFF") {
            return res.status(400).json({ message: error.message });
        }
        if (error && error.code === "APPOINTMENT_TICKET_ASSIGNMENT") {
            return res.status(400).json({ message: error.message });
        }
        console.error("Create ticket appointment error:", error);
        return res.status(500).json({ message: "Unable to create the appointment." });
    }
});

app.get(
    "/api/tickets/:ticketId/service-report",
    (req, res) => {
        try {
            const ticketId = req.params.ticketId;
            const workbook = XLSX.readFile(excelFile);

            if (!workbook.Sheets["ServiceReport"]) {
                return res.status(404).json({
                    message: "No service report found for this ticket."
                });
            }

            const reportsData = XLSX.utils.sheet_to_json(workbook.Sheets["ServiceReport"]);
            const ticketReports = reportsData.filter(report => String(report["Ticket ID"] || "").trim() === String(ticketId).trim());

            if (ticketReports.length === 0) {
                return res.status(404).json({
                    message: "No service report found for this ticket."
                });
            }

            res.json(ticketReports[ticketReports.length - 1]);

        } catch (error) {
            console.error("Get service report error:", error);
            res.status(500).json({
                message: "Unable to load service report."
            });
        }
    }
);

app.post(
    "/api/tickets/:ticketId/service-report",
    (req, res) => {

        try {

            const validationMessage = validateServiceReport(req.body);
            if (validationMessage) {
                return res.status(400).json({ message: validationMessage });
            }

            const ticketId = req.params.ticketId;
            const {
                onsite,
                serviceMode,
                engineer,
                date,
                signInTime,
                signOutTime,
                tasksDone,
                resolution,
                appointmentId,
                projectComplete = false
            } = req.body;
            if (projectComplete && !appointmentId) {
                return res.status(400).json({ message: "Select the Project appointment before marking it complete." });
            }

            const workbook = XLSX.readFile(excelFile);

            let reportsData = [];

            if (workbook.Sheets["ServiceReport"]) {
                reportsData = XLSX.utils.sheet_to_json(workbook.Sheets["ServiceReport"]);
            }

            const ticketSheet = workbook.Sheets["Ticket"];

            if (!ticketSheet) {
                return res.status(404).json({
                    message: "Ticket sheet not found."
                });
            }

            const ticketsData = XLSX.utils.sheet_to_json(ticketSheet);
            const ticketIndex = ticketsData.findIndex(ticket => ticket["Ticket ID"] === ticketId);

            if (ticketIndex === -1) {
                return res.status(404).json({
                    message: "Ticket not found."
                });
            }

            const ticket = ticketsData[ticketIndex];
            const appointments = readAppointments(workbook);
            const appointmentIndex = appointmentId
                ? appointments.findIndex(appointment =>
                    String(appointment["Appointment ID"] || "") === String(appointmentId) &&
                    String(appointment["Ticket ID"] || "") === String(ticketId)
                )
                : -1;
            let resolvedEngineer = engineer || "";
            if (isProjectCreditTicket(ticket) && !appointmentId) {
                return res.status(400).json({ message: "Select a Project appointment for this service report." });
            }
            if (appointmentId && appointmentIndex === -1) {
                return res.status(404).json({ message: "Appointment not found for this ticket." });
            }
            if (appointmentIndex >= 0) {
                const appointment = appointments[appointmentIndex];
                const isProject = Number(appointment["Project Days"] || 0) > 0;
                const roster = ensureStaffRoster(workbook).roster;
                const assignedTechnician = roster.find(person =>
                    String(person["Staff ID"] || "") === String(appointment["Staff ID"] || "")
                );
                resolvedEngineer = resolvedEngineer || String(assignedTechnician?.Name || "");
                if (!["Pending", "Confirmed"].includes(String(appointment.Status || ""))) {
                    return res.status(409).json({ message: "This appointment is not awaiting a service report." });
                }
                if (projectComplete && !isProject) {
                    return res.status(400).json({ message: "Only a multi-day Project appointment can be marked complete." });
                }
                if (!signInTime || !signOutTime || !date) {
                    return res.status(400).json({ message: "Appointment reports require a service date and sign-in and sign-out times." });
                }
                if (!isProject && reportsData.some(report =>
                    String(report["Appointment ID"] || "") === String(appointmentId)
                )) {
                    return res.status(409).json({ message: "A service report has already been submitted for this appointment." });
                }
                if (isProject && !projectReservationDates(appointment).includes(date)) {
                    return res.status(400).json({ message: "The service session date must be one of the reserved Project days." });
                }
                let actualEnd = localDateTime(date, signOutTime);
                const actualStart = localDateTime(date, signInTime);
                if (!Number.isFinite(actualStart) || !Number.isFinite(actualEnd)) {
                    return res.status(400).json({ message: "Provide valid service sign-in and sign-out times." });
                }
                if (actualEnd <= actualStart) {
                    actualEnd += 24 * 60 * 60 * 1000;
                }
                const plannedInterval = appointmentInterval(appointment, false);
                if (!plannedInterval || actualEnd <= plannedInterval.start) {
                    return res.status(400).json({ message: "The reported service time must end after this appointment starts." });
                }
                const actualEndDate = new Date(actualEnd);
                const actualEndDateString = [
                    actualEndDate.getFullYear(),
                    String(actualEndDate.getMonth() + 1).padStart(2, "0"),
                    String(actualEndDate.getDate()).padStart(2, "0")
                ].join("-");
                const actualEndTime = `${String(actualEndDate.getHours()).padStart(2, "0")}:${String(actualEndDate.getMinutes()).padStart(2, "0")}`;
                if (isProject) {
                    let sessions;
                    try {
                        sessions = JSON.parse(String(appointment["Service Sessions"] || "[]"));
                    } catch (error) {
                        throw new Error("Stored Project service sessions are invalid.", { cause: error });
                    }
                    if (!Array.isArray(sessions)) {
                        throw new Error("Stored Project service sessions must be a list.");
                    }
                    const currentSession = {
                        date,
                        signInTime,
                        endDate: actualEndDateString,
                        signOutTime: actualEndTime
                    };
                    const sessionAppointment = {
                        "Appointment ID": `${appointment["Appointment ID"]}-session`,
                        "Ticket ID": ticketId,
                        "Staff ID": appointment["Staff ID"],
                        "Start Date": date,
                        "Start Time": signInTime,
                        "End Date": actualEndDateString,
                        "End Time": actualEndTime,
                        "Project Days": 0,
                        Status: "Completed"
                    };
                    const previousSessions = sessions.map(session => ({
                        ...sessionAppointment,
                        "Appointment ID": `${appointment["Appointment ID"]}-session-${session.date}-${session.signInTime}`,
                        "Start Date": session.date,
                        "Start Time": session.signInTime,
                        "End Date": session.endDate || session.date,
                        "End Time": session.signOutTime
                    }));
                    if (hasSchedulingConflict(sessionAppointment, previousSessions)) {
                        return res.status(409).json({ message: "This Project service session overlaps another session or its travel buffer." });
                    }
                    sessions.push(currentSession);
                    appointment["Service Sessions"] = JSON.stringify(sessions);
                    appointment["Project Complete"] = projectComplete ? "Yes" : "No";
                    if (projectComplete) {
                        appointment["Actual Start Date"] = date;
                        appointment["Actual Start Time"] = signInTime;
                        appointment["Actual End Date"] = actualEndDateString;
                        appointment["Actual End Time"] = actualEndTime;
                        appointment.Status = "Completed";
                    }
                } else {
                    appointment["Actual Start Date"] = date;
                    appointment["Actual Start Time"] = signInTime;
                    appointment["Actual End Date"] = actualEndDateString;
                    appointment["Actual End Time"] = actualEndTime;
                    appointment.Status = "Completed";
                }
            }
            const newReport = buildServiceReportFromTicket(ticket, {
                onsite,
                serviceMode,
                engineer: resolvedEngineer,
                date,
                signInTime,
                signOutTime,
                tasksDone,
                resolution
            });
            if (appointmentIndex >= 0) {
                newReport["Appointment ID"] = String(appointmentId);
                newReport["Project Complete"] = projectComplete ? "Yes" : "No";
            }

            let creditSettlement = {
                actualChargedCredits: 0,
                additionalCredits: 0,
                refundedCredits: 0,
                unpaidCredits: 0,
                remainingCredits: null
            };
            let billableCredits = 0;

            if (isCreditBillableTicket(ticket)) {
                billableCredits = calculateBillableServiceReportCredits(
                    signInTime,
                    signOutTime
                );
                if (billableCredits <= 0) {
                    return res.status(400).json({
                        message: "A billable on-site service report requires sign-in and sign-out times with a positive duration."
                    });
                }

                if (!isProjectCreditTicket(ticket)) {
                    creditSettlement = settleTicketCredits(
                        workbook,
                        ticket,
                        billableCredits
                    );
                    if (creditSettlement.error) {
                        return res.status(500).json({ message: creditSettlement.error });
                    }
                }
            } else if (
                String(ticket["On-site Support Type"] || "").trim().toLowerCase() === "project"
            ) {
                ticket["Credit Settlement Status"] = "Exempt";
            } else {
                ticket["Credit Settlement Status"] = "Not Applicable";
            }

            Object.assign(newReport, {
                "Billable Credits": billableCredits,
                "Credits Charged": creditSettlement.actualChargedCredits,
                "Unpaid Credits": creditSettlement.unpaidCredits,
                "Credit Settlement Status": ticket["Credit Settlement Status"]
            });

            reportsData.push(newReport);
            if (isProjectCreditTicket(ticket)) {
                const projectBillableCredits = getProjectTicketBillableCredits(
                    reportsData,
                    ticketId
                );
                creditSettlement = settleProjectTicketCredits(
                    workbook,
                    ticket,
                    projectBillableCredits,
                    areProjectAppointmentsFinalized(appointments, ticketId)
                );
                if (creditSettlement.error) {
                    return res.status(500).json({ message: creditSettlement.error });
                }
                Object.assign(newReport, {
                    "Credits Charged": creditSettlement.additionalCredits,
                    "Unpaid Credits": creditSettlement.unpaidCredits,
                    "Credit Settlement Status": ticket["Credit Settlement Status"]
                });
                reportsData[reportsData.length - 1] = newReport;
            }

            ticketsData[ticketIndex]["Service Result"] = resolution || "";
            if (appointmentIndex >= 0) {
                appointments[appointmentIndex]["Service Report ID"] = newReport["Report ID"];
                flagVisitsConflictingWithCompletedAppointment(
                    workbook,
                    appointments,
                    appointmentIndex
                );
                const otherOpenAppointments = appointments.some(appointment =>
                    String(appointment["Ticket ID"] || "") === String(ticketId) &&
                    ["Pending", "Confirmed", "Reschedule Required"].includes(String(appointment.Status || ""))
                );
                if (!otherOpenAppointments) {
                    ticketsData[ticketIndex]["Status"] = "Closed";
                }
            } else {
                ticketsData[ticketIndex]["Status"] = "Closed";
            }

            if (engineer && appointmentIndex < 0) {
                ticketsData[ticketIndex]["Assigned Engineer"] = engineer;
            }
            if (appointmentIndex >= 0) {
                ticketsData[ticketIndex]["Visit Technician"] = resolvedEngineer;
            }

            setWorkbookSheet(
                workbook,
                "ServiceReport",
                XLSX.utils.json_to_sheet(reportsData)
            );
            if (appointmentIndex >= 0) {
                saveAppointments(workbook, appointments);
            }
            workbook.Sheets["Ticket"] = XLSX.utils.json_to_sheet(ticketsData);

            writeWorkbook(workbook);

            console.log("Service report created:", newReport);

            res.status(201).json({
                message: getServiceReportCreditMessage(ticket, billableCredits, creditSettlement),
                report: newReport,
                creditSettlement
            });

        } catch (error) {
            console.error("Service report error:", error);
            res.status(500).json({
                message: "Unable to create service report."
            });
        }
    }
);

app.put(
    "/api/tickets/:ticketId/service-report",
    (req, res) => {
        try {

            const validationMessage = validateServiceReport(req.body);
            if (validationMessage) {
                return res.status(400).json({ message: validationMessage });
            }

            const ticketId = req.params.ticketId;
            const {
                onsite,
                serviceMode,
                engineer,
                date,
                signInTime,
                signOutTime,
                tasksDone,
                resolution,
                projectComplete
            } = req.body;

            const workbook = XLSX.readFile(excelFile);

            if (!workbook.Sheets["ServiceReport"]) {
                return res.status(404).json({
                    message: "No service report found for this ticket."
                });
            }

            const reportsData = XLSX.utils.sheet_to_json(workbook.Sheets["ServiceReport"]);
            const reportIndex = reportsData.findLastIndex(
                report => String(report["Ticket ID"] || "").trim() === String(ticketId).trim()
            );

            if (reportIndex === -1) {
                return res.status(404).json({
                    message: "No service report found for this ticket."
                });
            }

            const existingReport = reportsData[reportIndex];
            const ticketSheet = workbook.Sheets["Ticket"];
            if (!ticketSheet) {
                return res.status(404).json({ message: "Ticket sheet not found." });
            }

            const ticketsData = XLSX.utils.sheet_to_json(ticketSheet);
            const ticketIndex = ticketsData.findIndex(ticket => ticket["Ticket ID"] === ticketId);
            if (ticketIndex === -1) {
                return res.status(404).json({ message: "Ticket not found." });
            }

            const ticket = ticketsData[ticketIndex];
            const nextSignInTime = signInTime || existingReport.SignInTime || "";
            const nextSignOutTime = signOutTime || existingReport.SignOutTime || "";
            let billableCredits = 0;
            let creditSettlement = {
                actualChargedCredits: 0,
                additionalCredits: 0,
                refundedCredits: 0,
                unpaidCredits: 0,
                remainingCredits: null
            };

            if (isCreditBillableTicket(ticket)) {
                billableCredits = calculateBillableServiceReportCredits(
                    nextSignInTime,
                    nextSignOutTime
                );
                if (billableCredits <= 0) {
                    return res.status(400).json({
                        message: "A billable on-site service report requires sign-in and sign-out times with a positive duration."
                    });
                }

                if (!isProjectCreditTicket(ticket)) {
                    creditSettlement = settleTicketCredits(
                        workbook,
                        ticket,
                        billableCredits
                    );
                    if (creditSettlement.error) {
                        return res.status(500).json({ message: creditSettlement.error });
                    }
                }
            } else if (
                String(ticket["On-site Support Type"] || "").trim().toLowerCase() === "project"
            ) {
                ticket["Credit Settlement Status"] = "Exempt";
            } else {
                ticket["Credit Settlement Status"] = "Not Applicable";
            }

            const resolvedServiceMode = normalizeServiceMode(serviceMode, onsite ?? (existingReport.Onsite === "Yes"));
            const updatedReport = {
                ...existingReport,
                "Engineer": engineer || existingReport.Engineer || "",
                "ServiceMode": resolvedServiceMode,
                "Onsite": ["On-site", "Hybrid"].includes(resolvedServiceMode) ? "Yes" : "No",
                "Date": date || existingReport.Date || new Date().toISOString().split("T")[0],
                "SignInTime": nextSignInTime,
                "SignOutTime": nextSignOutTime,
                "TasksDone": tasksDone || existingReport.TasksDone || "",
                "Resolution": resolution || existingReport.Resolution || "",
                "HoursSpent": calculateServiceReportHours(nextSignInTime, nextSignOutTime),
                "Billable Credits": billableCredits,
                "Credits Charged": creditSettlement.actualChargedCredits,
                "Unpaid Credits": creditSettlement.unpaidCredits,
                "Credit Settlement Status": ticket["Credit Settlement Status"]
            };

            const reportAppointmentId = String(existingReport["Appointment ID"] || "");
            updatedReport["Project Complete"] = projectComplete === undefined
                ? String(existingReport["Project Complete"] || "No")
                : projectComplete ? "Yes" : "No";
            if (reportAppointmentId) {
                const appointments = readAppointments(workbook);
                const appointmentIndex = appointments.findIndex(appointment =>
                    String(appointment["Appointment ID"] || "") === reportAppointmentId &&
                    String(appointment["Ticket ID"] || "") === String(ticketId)
                );
                if (appointmentIndex === -1) {
                    return res.status(409).json({ message: "The appointment linked to this report no longer exists." });
                }
                const appointment = appointments[appointmentIndex];
                const isProject = Number(appointment["Project Days"] || 0) > 0;
                if (isProject) {
                    if (!projectReservationDates(appointment).includes(updatedReport.Date)) {
                        return res.status(400).json({ message: "The service session date must be one of the reserved Project days." });
                    }
                    reportsData[reportIndex] = updatedReport;
                    const sessions = syncProjectAppointmentFromReports(appointment, reportsData);
                    const sessionRows = sessions.map(session => ({
                        "Appointment ID": `${appointment["Appointment ID"]}-session-${session.date}-${session.signInTime}`,
                        "Ticket ID": ticketId,
                        "Staff ID": appointment["Staff ID"],
                        "Start Date": session.date,
                        "Start Time": session.signInTime,
                        "End Date": session.endDate,
                        "End Time": session.signOutTime,
                        "Project Days": 0,
                        Status: "Completed"
                    }));
                    if (sessionRows.some((session, index) =>
                        hasSchedulingConflict(session, sessionRows.filter((_, row) => row !== index))
                    )) {
                        return res.status(409).json({ message: "Project work sessions must not overlap and must include one hour of travel time." });
                    }
                } else {
                    const actualSession = getActualSessionFromReport(updatedReport);
                    if (!actualSession) {
                        return res.status(400).json({ message: "Provide valid service sign-in and sign-out times." });
                    }
                    const updatedAppointment = {
                        ...appointment,
                        "Actual Start Date": updatedReport.Date,
                        "Actual Start Time": updatedReport.SignInTime,
                        "Actual End Date": actualSession.endDate,
                        "Actual End Time": actualSession.signOutTime,
                        Status: "Completed"
                    };
                    if (hasSchedulingConflict(
                        updatedAppointment,
                        appointments.filter((_, index) => index !== appointmentIndex)
                    )) {
                        return res.status(409).json({ message: "Changing this report would create an appointment overlap or violate the travel buffer." });
                    }
                    Object.assign(appointment, updatedAppointment);
                }
                flagVisitsConflictingWithCompletedAppointment(
                    workbook,
                    appointments,
                    appointmentIndex
                );
                if (isProject && appointment.Status === "Pending") {
                    flagVisitsConflictingWithAppointmentReservation(
                        workbook,
                        appointments,
                        appointmentIndex
                    );
                }
                saveAppointments(workbook, appointments);
            }

            reportsData[reportIndex] = updatedReport;

            ticket["Service Result"] = updatedReport.Resolution || "";
            if (engineer && !reportAppointmentId) {
                ticket["Assigned Engineer"] = engineer;
            } else if (reportAppointmentId && engineer) {
                ticket["Visit Technician"] = engineer;
            }
            if (reportAppointmentId) {
                const otherOpenAppointments = readAppointments(workbook).some(appointment =>
                    String(appointment["Ticket ID"] || "") === String(ticketId) &&
                    ["Pending", "Confirmed", "Reschedule Required"].includes(String(appointment.Status || ""))
                );
                if (otherOpenAppointments && ticket.Status === "Closed") {
                    ticket.Status = "In Progress";
                } else if (!otherOpenAppointments) {
                    ticket.Status = "Closed";
                }
            }
            if (isProjectCreditTicket(ticket)) {
                creditSettlement = settleProjectTicketCredits(
                    workbook,
                    ticket,
                    getProjectTicketBillableCredits(reportsData, ticketId),
                    areProjectAppointmentsFinalized(readAppointments(workbook), ticketId)
                );
                if (creditSettlement.error) {
                    return res.status(500).json({ message: creditSettlement.error });
                }
                updatedReport["Credits Charged"] = creditSettlement.additionalCredits;
                updatedReport["Unpaid Credits"] = creditSettlement.unpaidCredits;
                updatedReport["Credit Settlement Status"] = ticket["Credit Settlement Status"];
            }
            workbook.Sheets["Ticket"] = XLSX.utils.json_to_sheet(ticketsData);

            setWorkbookSheet(
                workbook,
                "ServiceReport",
                XLSX.utils.json_to_sheet(reportsData)
            );
            writeWorkbook(workbook);

            res.json({
                message: getServiceReportCreditMessage(ticket, billableCredits, creditSettlement)
                    .replace("generated and saved", "updated and saved"),
                report: updatedReport,
                creditSettlement
            });

        } catch (error) {
            console.error("Update service report error:", error);
            res.status(500).json({
                message: "Unable to update service report."
            });
        }
    }
);

app.delete(
    "/api/tickets/:ticketId/service-report",
    (req, res) => {
        try {
            const ticketId = req.params.ticketId;
            const workbook = XLSX.readFile(excelFile);

            if (!workbook.Sheets["ServiceReport"]) {
                return res.status(404).json({
                    message: "No service report found for this ticket."
                });
            }

            const reportsData = XLSX.utils.sheet_to_json(workbook.Sheets["ServiceReport"]);
            const reportIndex = reportsData.findLastIndex(
                report => String(report["Ticket ID"] || "").trim() === String(ticketId).trim()
            );

            if (reportIndex === -1) {
                return res.status(404).json({
                    message: "No service report found for this ticket."
                });
            }

            const deletedReport = reportsData[reportIndex];
            reportsData.splice(reportIndex, 1);
            setWorkbookSheet(
                workbook,
                "ServiceReport",
                XLSX.utils.json_to_sheet(reportsData)
            );
            const appointmentId = String(deletedReport["Appointment ID"] || "");
            if (appointmentId && workbook.Sheets.Appointment) {
                const appointments = readAppointments(workbook);
                const appointment = appointments.find(row =>
                    String(row["Appointment ID"] || "") === appointmentId &&
                    String(row["Ticket ID"] || "") === String(ticketId)
                );
                if (appointment) {
                    if (Number(appointment["Project Days"] || 0) > 0) {
                        syncProjectAppointmentFromReports(appointment, reportsData);
                        const appointmentIndex = appointments.indexOf(appointment);
                        if (appointment.Status === "Pending") {
                            flagVisitsConflictingWithAppointmentReservation(
                                workbook,
                                appointments,
                                appointmentIndex
                            );
                        }
                    } else {
                        appointment["Actual End Date"] = "";
                        appointment["Actual End Time"] = "";
                        appointment["Actual Start Date"] = "";
                        appointment["Actual Start Time"] = "";
                        appointment["Service Report ID"] = "";
                        appointment.Status = appointment["Staff ID"] ? "Pending" : "Reschedule Required";
                    }
                    saveAppointments(workbook, appointments);
                    const ticketSheet = workbook.Sheets.Ticket;
                    if (ticketSheet) {
                        const tickets = XLSX.utils.sheet_to_json(ticketSheet);
                        const ticket = tickets.find(row =>
                            String(row["Ticket ID"] || "") === String(ticketId)
                        );
                        if (ticket) {
                            const hasOpenAppointment = appointments.some(row =>
                                String(row["Ticket ID"] || "") === String(ticketId) &&
                                ["Pending", "Confirmed", "Reschedule Required"].includes(String(row.Status || ""))
                            );
                            if (hasOpenAppointment && ticket.Status === "Closed") {
                                ticket.Status = "In Progress";
                            } else if (!hasOpenAppointment) {
                                ticket.Status = "Closed";
                            }
                            ticket["Appointment Status"] = appointment.Status;
                            workbook.Sheets.Ticket = XLSX.utils.json_to_sheet(tickets);
                        }
                    }
                }
            }
            const ticketSheet = workbook.Sheets.Ticket;
            if (ticketSheet) {
                const tickets = XLSX.utils.sheet_to_json(ticketSheet);
                const ticket = tickets.find(row =>
                    String(row["Ticket ID"] || "") === String(ticketId)
                );
                if (ticket && isProjectCreditTicket(ticket)) {
                    const settlement = settleProjectTicketCredits(
                        workbook,
                        ticket,
                        getProjectTicketBillableCredits(reportsData, ticketId),
                        areProjectAppointmentsFinalized(readAppointments(workbook), ticketId)
                    );
                    if (settlement.error) {
                        return res.status(500).json({ message: settlement.error });
                    }
                    workbook.Sheets.Ticket = XLSX.utils.json_to_sheet(tickets);
                }
            }
            writeWorkbook(workbook);

            res.json({
                message: "Service report deleted successfully."
            });

        } catch (error) {
            console.error("Delete service report error:", error);
            res.status(500).json({
                message: "Unable to delete service report."
            });
        }
    }
);


/* =========================================================
   GET SERVICE REPORTS FOR A TICKET
========================================================= */

app.get(
    "/api/tickets/:ticketId/service-reports",
    (req, res) => {

        try {

            const ticketId =
                req.params.ticketId;


            const workbook =
                XLSX.readFile(
                    excelFile
                );


            /* =========================
               NO SERVICE REPORT SHEET
            ========================= */

            if (
                !workbook.Sheets[
                    "ServiceReport"
                ]
            ) {

                return res.json([]);

            }


            const reportsData =
                XLSX.utils.sheet_to_json(
                    workbook.Sheets[
                        "ServiceReport"
                    ]
                );


            const ticketReports =
                reportsData.filter(
                    report =>
                        report["Ticket ID"] ===
                        ticketId
                );


            res.json(
                ticketReports
            );

        } catch (error) {

            console.error(
                "Get service reports error:",
                error
            );

            res.status(500).json({

                message:
                    "Unable to load service reports."

            });

        }

    }
);


app.use((error, req, res, next) => {
    if (error && error.type === "entity.too.large") {
        return res.status(413).json({
            message: "Request body exceeds the 32 KB limit."
        });
    }

    if (error && error.type === "entity.parse.failed") {
        return res.status(400).json({
            message: "Request body must contain valid JSON."
        });
    }

    return res.status(500).json({
        message: "Unable to process request."
    });
});


/* =========================================================
   START SERVER
========================================================= */

if (require.main === module) {
    try {
        const startupWorkbook = XLSX.readFile(excelFile);
        const startupRepair = repairMissingCustomerLinks(startupWorkbook);

        if (startupRepair.changed) {
            console.log(
                `Startup repair fixed ${startupRepair.fixedCount} orphaned or missing customer ticket link(s).`
            );
        }
    } catch (error) {
        console.error(
            "Startup customer repair error:",
            error
        );
    }

    app.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log(
                `IT Ticketing System running on http://localhost:${PORT}`
            );

        }
    );
}

module.exports = app;
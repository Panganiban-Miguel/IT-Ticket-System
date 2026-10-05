const express = require("express");
const { rateLimit } = require("express-rate-limit");
const crypto = require("node:crypto");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

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

function writeWorkbook(workbook) {
    acquireWorkbookLock();

    const tempWorkbookPath = path.join(
        excelDir,
        `database-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp.xlsx`
    );

    try {
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
        ["appointmentTime", "Appointment time", 5]
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
        body.appointmentDuration !== undefined &&
        body.appointmentDuration !== null &&
        typeof body.appointmentDuration !== "string" &&
        typeof body.appointmentDuration !== "number"
    ) {
        return "Appointment duration must be a number.";
    }

    if (
        body.appointmentDuration !== undefined &&
        body.appointmentDuration !== null &&
        String(body.appointmentDuration).trim() !== "" &&
        !Number.isFinite(Number(body.appointmentDuration))
    ) {
        return "Appointment duration must be a valid number.";
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
    return (
        String(ticket["Support Type"] || "").trim().toLowerCase() === "on-site support" &&
        String(ticket["On-site Support Type"] || "").trim().toLowerCase() !== "project"
    );
}

function getTicketEstimatedCredits(ticket) {
    if (!isCreditBillableTicket(ticket)) {
        return 0;
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

        const customerResolution =
            resolveCustomerForTicket(
                customersData,
                submittedCustomerId,
                submittedEmail,
                submittedName,
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
            const appointmentValidationMessage = validateAppointmentDateTime(
                appointmentDate,
                appointmentTime
            );

            if (appointmentValidationMessage) {
                return res.status(400).json({
                    message: appointmentValidationMessage
                });
            }

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

            originalAppointmentDuration =
                parseFloat(
                    req.body.appointmentDuration
                );

            appointmentDuration = originalAppointmentDuration;


            /* =========================
               CHECK DURATION
            ========================= */

            if (onSiteSupportType === "Project") {
                if (
                    !Number.isFinite(appointmentDuration) ||
                    !Number.isInteger(appointmentDuration) ||
                    appointmentDuration < 1
                ) {
                    return res.status(400).json({
                        message:
                            "Project duration is required and must be a whole number of days (minimum 1 day)."
                    });
                }
            } else {
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


        /* =========================
           CHECK CREDITS
        ========================= */

        if (
            customer &&
            isOnSiteSupportRequest &&
            onSiteSupportType !== "Project" &&
            currentCredits <
            appointmentDuration
        ) {

            return res.status(400).json({

                message:
                    "The customer only has " +
                    currentCredits +
                    " credit(s), but requested " +
                    appointmentDuration +
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
            onSiteSupportType !== "Project"
        ) {

            remainingCredits =
                currentCredits -
                appointmentDuration;


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

            "Credits Charged":
                isOnSiteSupportRequest && onSiteSupportType !== "Project"
                    ? appointmentDuration
                    : 0,

            "Billable Credits":
                isOnSiteSupportRequest && onSiteSupportType !== "Project"
                    ? appointmentDuration
                    : 0,

            "Unpaid Credits":
                0,

            "Credit Settlement Status":
                isOnSiteSupportRequest
                    ? onSiteSupportType === "Project" ? "Exempt" : "Pending"
                    : "Not Applicable",

            "Appointment Status":
                "Pending",

            "Created Date":
                new Date().toISOString(),

            "Service Result":
                ""

        };


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

        writeWorkbook(workbook);

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
                !!roundedDurationNotice

        });

    } catch (error) {

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

            ticketsData[ticketIndex][
                "Assigned Engineer"
            ] =
                req.body.assignedEngineer || "";


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
                !hasServiceReport &&
                settlementStatus !== "Settled";

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

app.get("/api/staff", (req, res) => {

    try {

        const workbook =
            XLSX.readFile(
                excelFile
            );


        const worksheet =
            workbook.Sheets["Staff"];


        if (!worksheet) {

            return res.status(404).json({

                message:
                    "Staff sheet not found."

            });

        }


        const staffData =
            XLSX.utils.sheet_to_json(
                worksheet
            );


        /*
           ONLY RETURN STAFF WHO CAN
           BE ASSIGNED AS ENGINEERS.
        */

        /*
           Future-ready hook for technician-only filtering.
           Do not enable until a real technician role exists in the staff data.
        */
        const staffList =
            staffData
                .filter(
                    staff =>
                        String(
                            staff.Role || ""
                        ).trim() ===
                            "IT Support Staff" ||
                        String(
                            staff.Role || ""
                        ).trim() ===
                            "Engineer"
                )
                .map(
                    staff => ({

                        staffId:
                            staff["Staff ID"],

                        name:
                            staff.Name,

                        email:
                            staff.Email,

                        role:
                            staff.Role,

                        department:
                            staff.Department

                    })
                );


        res.json(
            staffList
        );

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
                resolution
            } = req.body;

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
            const newReport = buildServiceReportFromTicket(ticket, {
                onsite,
                serviceMode,
                engineer,
                date,
                signInTime,
                signOutTime,
                tasksDone,
                resolution
            });

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

                creditSettlement = settleTicketCredits(
                    workbook,
                    ticket,
                    billableCredits
                );
                if (creditSettlement.error) {
                    return res.status(500).json({ message: creditSettlement.error });
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

            ticketsData[ticketIndex]["Status"] = "Closed";
            ticketsData[ticketIndex]["Service Result"] = resolution || "";

            if (engineer) {
                ticketsData[ticketIndex]["Assigned Engineer"] = engineer;
            }

            setWorkbookSheet(
                workbook,
                "ServiceReport",
                XLSX.utils.json_to_sheet(reportsData)
            );
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
                resolution
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

                creditSettlement = settleTicketCredits(
                    workbook,
                    ticket,
                    billableCredits
                );
                if (creditSettlement.error) {
                    return res.status(500).json({ message: creditSettlement.error });
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

            reportsData[reportIndex] = updatedReport;

            ticket["Service Result"] = updatedReport.Resolution || "";
            if (engineer) {
                ticket["Assigned Engineer"] = engineer;
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

            reportsData.splice(reportIndex, 1);
            setWorkbookSheet(
                workbook,
                "ServiceReport",
                XLSX.utils.json_to_sheet(reportsData)
            );
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
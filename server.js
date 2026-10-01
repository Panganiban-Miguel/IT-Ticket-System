const express = require("express");
const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

const app = express();
const PORT = process.env.PORT || 3000;

const excelDir = path.join(
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

function getNextCustomerId(customersData) {
    let candidate = 1;

    while (true) {
        const candidateId = `C-${String(candidate).padStart(13, "0")}`;
        const isTaken = customersData.some(
            customer => String(customer["Customer ID"] || "").trim() === candidateId
        );

        if (!isTaken) {
            return candidateId;
        }

        candidate += 1;
    }
}

function resolveCustomerForTicket(customersData, submittedCustomerId, submittedEmail, submittedName) {
    const normalizedEmail = normalizeEmail(submittedEmail);

    if (submittedCustomerId) {
        const customerIndex = customersData.findIndex(
            customer => String(customer["Customer ID"] || "") === String(submittedCustomerId)
        );

        if (customerIndex === -1) {
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

    const customerIndex = customersData.findIndex(
        customer => normalizeEmail(customer.Email || "") === normalizedEmail
    );

    if (customerIndex !== -1) {
        const customer = customersData[customerIndex];

        if (!String(customer.Name || "").trim() && submittedName) {
            customer.Name = submittedName;
        }

        return { customer, customerIndex, created: false, reason: null };
    }

    const newCustomer = {
        "Customer ID": getNextCustomerId(customersData),
        "Name": submittedName || "",
        "Email": submittedEmail || "",
        "Password": "",
        "Credits": 0
    };

    customersData.push(newCustomer);

    return { customer: newCustomer, customerIndex: customersData.length - 1, created: true, reason: null };
}

function repairMissingCustomerLinks(workbook) {
    const customerWorksheet = workbook.Sheets["Customer"];
    const ticketWorksheet = workbook.Sheets["Ticket"];

    if (!customerWorksheet || !ticketWorksheet) {
        return { fixedCount: 0, changed: false };
    }

    const customersData = XLSX.utils.sheet_to_json(customerWorksheet);
    const ticketsData = XLSX.utils.sheet_to_json(ticketWorksheet);

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
            matchedCustomer = customersData.find(
                customer => String(customer["Customer ID"] || "").trim() === ticketCustomerId
            );
        }

        if (!matchedCustomer && ticketEmail) {
            matchedCustomer = customersData.find(
                customer => normalizeEmail(customer.Email || "") === normalizeEmail(ticketEmail)
            );
        }

        if (!matchedCustomer && ticketEmail) {
            const createdCustomer = resolveCustomerForTicket(
                customersData,
                "",
                ticketEmail,
                ticketName
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

app.use(express.json());

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

app.post("/api/staff/login", (req, res) => {

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
                        staffPassword === enteredPassword
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


        res.json({

            message:
                "Login successful.",

            staff: {

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

            }

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


/* =========================================================
   CREATE TICKET
========================================================= */

app.post("/api/tickets", (req, res) => {
    return res.status(410).json({
        message: "Customer ticket submission is currently disabled."
    });
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

            let resolvedCustomer = null;
            let customerResolution = null;

            if (customerRecordToUse || customerEmailToUse) {
                customerResolution =
                    resolveCustomerForTicket(
                        customersData,
                        customerRecordToUse,
                        customerEmailToUse,
                        customerNameToUse
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

        }

    }
);


/* =========================================================
   DELETE TICKET
========================================================= */

app.delete(
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

            const supportType =
                String(
                    ticketToDelete["Support Type"] || ""
                ).trim();

            const ticketStatus =
                String(
                    ticketToDelete["Status"] || ""
                ).trim();

            const appointmentStatus =
                String(
                    ticketToDelete["Appointment Status"] || ""
                ).trim();

            const assignedEngineer =
                String(
                    ticketToDelete["Assigned Engineer"] || ""
                ).trim();

            const appointmentDuration =
                Number(
                    ticketToDelete["Appointment Duration"] || 0
                );

            const serviceResult =
                String(
                    ticketToDelete["Service Result"] || ""
                ).trim();

            const hasServiceReport =
                (() => {
                    const workbookReports =
                        workbook.Sheets["ServiceReport"];

                    if (!workbookReports) {
                        return false;
                    }

                    const reportsData =
                        XLSX.utils.sheet_to_json(
                            workbookReports
                        );

                    return reportsData.some(
                        report =>
                            String(report["Ticket ID"] || "").trim() === ticketId
                    );
                })();

            const activeStatuses =
                ["open", "in progress"];

            const pendingAppointmentStatuses =
                ["pending", "reschedule required"];

            const isOnSiteSupport =
                supportType.toLowerCase() ===
                "on-site support";

            const isOpenOrInProgress =
                activeStatuses.includes(
                    ticketStatus.toLowerCase()
                );

            const isPendingOrReschedule =
                pendingAppointmentStatuses.includes(
                    appointmentStatus.toLowerCase()
                );

            const isServiceResultEmpty =
                serviceResult === "";

            const isServiceReportMissing =
                !hasServiceReport;

            const refundCheck = {
                ticketId,
                supportType,
                ticketStatus,
                appointmentStatus,
                assignedEngineer,
                appointmentDuration,
                serviceResult,
                hasServiceReport,
                isOnSiteSupport,
                isOpenOrInProgress,
                isPendingOrReschedule,
                isServiceResultEmpty,
                isServiceReportMissing,
                refundEligible:
                    isOnSiteSupport &&
                    isOpenOrInProgress &&
                    isPendingOrReschedule &&
                    isServiceResultEmpty &&
                    isServiceReportMissing &&
                    Number.isFinite(appointmentDuration) &&
                    appointmentDuration > 0
            };

            console.log(
                "Delete refund eligibility debug:",
                JSON.stringify(refundCheck, null, 2)
            );

            let refundApplied = false;
            let refundedCredits = 0;
            const refundReasons = [];

            if (!isOnSiteSupport) {
                refundReasons.push("Support type is not On-site Support.");
            }

            if (!isOpenOrInProgress) {
                refundReasons.push("Ticket status is not Open/In Progress.");
            }

            if (!isPendingOrReschedule) {
                refundReasons.push("Appointment status is not Pending/Reschedule Required.");
            }

            if (!isServiceResultEmpty) {
                refundReasons.push("Service result is not empty.");
            }

            if (!isServiceReportMissing) {
                refundReasons.push("A service report already exists.");
            }

            if (
                !Number.isFinite(appointmentDuration) ||
                appointmentDuration <= 0
            ) {
                refundReasons.push("Appointment duration is invalid or zero.");
            }

            if (
                isOnSiteSupport &&
                isOpenOrInProgress &&
                isPendingOrReschedule &&
                isServiceResultEmpty &&
                isServiceReportMissing &&
                Number.isFinite(appointmentDuration) &&
                appointmentDuration > 0
            ) {
                const customerWorksheet =
                    workbook.Sheets["Customer"];

                if (customerWorksheet) {
                    const customersData =
                        XLSX.utils.sheet_to_json(
                            customerWorksheet
                        );

                    const customerId =
                        String(
                            ticketToDelete["Customer ID"] || ""
                        ).trim();

                    const customerEmail =
                        String(
                            ticketToDelete["Email"] || ""
                        ).trim();

                    let customerIndex = -1;
                    let targetCustomer = null;

                    if (customerId) {
                        customerIndex = customersData.findIndex(
                            customer =>
                                String(customer["Customer ID"] || "").trim() === customerId
                        );
                    }

                    if (customerIndex === -1 && customerEmail) {
                        customerIndex = customersData.findIndex(
                            customer =>
                                String(customer["Email"] || "").trim().toLowerCase() === customerEmail.toLowerCase()
                        );
                    }

                    if (customerIndex !== -1) {
                        targetCustomer = customersData[customerIndex];

                        const currentCredits =
                            Number(
                                targetCustomer["Credits"] || 0
                            );

                        refundedCredits =
                            appointmentDuration;

                        targetCustomer["Credits"] =
                            currentCredits + refundedCredits;

                        workbook.Sheets["Customer"] =
                            XLSX.utils.json_to_sheet(
                                customersData
                            );

                        refundApplied = true;
                    }
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

            if (!refundApplied && refundReasons.length > 0) {
                console.log(
                    "Refund skipped because:",
                    refundReasons
                );
            }


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

function calculateServiceReportHours(signInTime, signOutTime) {
    if (!signInTime || !signOutTime) {
        return 0;
    }

    const start = new Date(`1970-01-01T${signInTime}:00`);
    const end = new Date(`1970-01-01T${signOutTime}:00`);
    const diffMs = end - start;

    if (diffMs <= 0) {
        return 0;
    }

    return +(diffMs / (1000 * 60 * 60)).toFixed(2);
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
        "TasksDone": tasksDone || "",
        "Resolution": resolution || "",
        "Created At": new Date().toISOString()
    };
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

            reportsData.push(newReport);

            ticketsData[ticketIndex]["Status"] = "Closed";
            ticketsData[ticketIndex]["Service Result"] = resolution || "";

            if (engineer) {
                ticketsData[ticketIndex]["Assigned Engineer"] = engineer;
            }

            workbook.Sheets["ServiceReport"] = XLSX.utils.json_to_sheet(reportsData);
            workbook.Sheets["Ticket"] = XLSX.utils.json_to_sheet(ticketsData);

            writeWorkbook(workbook);

            console.log("Service report created:", newReport);

            res.status(201).json({
                message: "Service report generated and saved successfully.",
                report: newReport
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
            const resolvedServiceMode = normalizeServiceMode(serviceMode, onsite ?? (existingReport.Onsite === "Yes"));
            const updatedReport = {
                ...existingReport,
                "Engineer": engineer || existingReport.Engineer || "",
                "ServiceMode": resolvedServiceMode,
                "Onsite": ["On-site", "Hybrid"].includes(resolvedServiceMode) ? "Yes" : "No",
                "Date": date || existingReport.Date || new Date().toISOString().split("T")[0],
                "SignInTime": signInTime || existingReport.SignInTime || "",
                "SignOutTime": signOutTime || existingReport.SignOutTime || "",
                "TasksDone": tasksDone || existingReport.TasksDone || "",
                "Resolution": resolution || existingReport.Resolution || "",
                "HoursSpent": calculateServiceReportHours(signInTime || existingReport.SignInTime || "", signOutTime || existingReport.SignOutTime || "")
            };

            reportsData[reportIndex] = updatedReport;

            const ticketSheet = workbook.Sheets["Ticket"];
            if (ticketSheet) {
                const ticketsData = XLSX.utils.sheet_to_json(ticketSheet);
                const ticketIndex = ticketsData.findIndex(ticket => ticket["Ticket ID"] === ticketId);

                if (ticketIndex !== -1) {
                    ticketsData[ticketIndex]["Service Result"] = updatedReport.Resolution || "";
                    if (engineer) {
                        ticketsData[ticketIndex]["Assigned Engineer"] = engineer;
                    }
                    workbook.Sheets["Ticket"] = XLSX.utils.json_to_sheet(ticketsData);
                }
            }

            workbook.Sheets["ServiceReport"] = XLSX.utils.json_to_sheet(reportsData);
            writeWorkbook(workbook);

            res.json({
                message: "Service report updated successfully.",
                report: updatedReport
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
            workbook.Sheets["ServiceReport"] = XLSX.utils.json_to_sheet(reportsData);
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


/* =========================================================
   START SERVER
========================================================= */

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
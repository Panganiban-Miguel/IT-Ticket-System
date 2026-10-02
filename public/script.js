/* =========================================================
   MAIN PAGE
========================================================= */

/*
   CUSTOMER-FACING ENTRY DISABLED.
   Restore by uncommenting the original block below.
   Original behavior: redirect customer users to /customer-login.html
   // function loginAsCustomer() {
   //     window.location.href = "/customer-login.html";
   // }
*/

function loginAsStaff() {
    window.location.href = "/staff-login.html";
}


/* =========================================================
   STAFF LOGIN
========================================================= */

const staffLoginForm = document.getElementById("staffLoginForm");

if (staffLoginForm) {

    staffLoginForm.addEventListener("submit", async function (event) {

        event.preventDefault();

        const email =
            document.getElementById("staffEmail").value.trim();

        const password =
            document.getElementById("staffPassword").value;

        if (!email || !password) {
            alert("Please enter the customer's email and password.");
            return;
        }

        try {

            const response = await fetch("/api/staff/login", {

                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    email: email,
                    password: password
                })

            });

            const data = await response.json();

            if (response.ok) {

                localStorage.setItem(
                    "staff",
                    JSON.stringify(data.staff)
                );

                alert("Login successful!");

                window.location.href = "/staff.html";

            } else {

                alert(
                    data.message ||
                    "Invalid email or password."
                );

            }

        } catch (error) {

            console.error("Staff login error:", error);

            alert(
                "Unable to connect to the server. Please make sure the server is running."
            );

        }

    });

}

const staffMenuToggle =
    document.getElementById("staffMenuToggle");

const staffNavigation =
    document.getElementById("staffNav");

if (staffMenuToggle && staffNavigation) {
    function closeStaffMenu() {
        staffMenuToggle.setAttribute("aria-expanded", "false");
        staffMenuToggle.setAttribute("aria-label", "Open staff menu");
        staffNavigation.classList.remove("is-open");
    }

    staffMenuToggle.addEventListener("click", () => {
        const isExpanded =
            staffMenuToggle.getAttribute("aria-expanded") === "true";

        staffMenuToggle.setAttribute("aria-expanded", String(!isExpanded));
        staffMenuToggle.setAttribute(
            "aria-label",
            isExpanded ? "Open staff menu" : "Close staff menu"
        );
        staffNavigation.classList.toggle("is-open", !isExpanded);
    });

    staffNavigation.addEventListener("click", event => {
        if (event.target.closest("a")) {
            closeStaffMenu();
        }
    });

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") {
            closeStaffMenu();
        }
    });
}


/* =========================================================
   CUSTOMER TICKET FORM
========================================================= */

const ticketForm = document.getElementById("ticketForm");

const supportTypeSelect =
    document.getElementById("supportType");

const appointmentSection =
    document.getElementById("appointmentSection");

const onSiteSupportTypeSelect =
    document.getElementById("onSiteSupportType");

const durationField =
    document.getElementById("durationField");

const durationLabel =
    document.getElementById("durationLabel");

const appointmentDurationInput =
    document.getElementById("appointmentDuration");


function roundUpToHalfHour(value) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
        return null;
    }

    return Math.ceil(numericValue * 2) / 2;
}


function getOnSiteDurationSettings(onSiteSupportType) {

    switch ((onSiteSupportType || "").trim()) {

        case "Maintenance":
            return {
                minHours: 1,
                label: "Minimum 1 hour",
                unit: "hours",
                step: "0.5",
                minValue: 1
            };

        case "Ad Hoc":
            return {
                minHours: 2,
                label: "Minimum 2 hours",
                unit: "hours",
                step: "0.5",
                minValue: 1
            };

        case "Project":
            return {
                minHours: 0,
                label: "Minimum 1 day",
                unit: "days",
                step: "1",
                minValue: 1,
                wholeNumberOnly: true,
                skipCredits: true
            };

        default:
            return null;
    }

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


/* =========================================================
   SHOW / HIDE APPOINTMENT FIELDS
========================================================= */

if (supportTypeSelect && appointmentSection) {

    function updateAppointmentFields() {

        const supportType =
            supportTypeSelect.value.trim().toLowerCase();

        const isOnSiteSupport =
            supportType === "on-site support";


        appointmentSection.style.display =
            isOnSiteSupport ? "block" : "none";


        if (!isOnSiteSupport) {

            const appointmentDate =
                document.getElementById("appointmentDate");

            const appointmentTime =
                document.getElementById("appointmentTime");

            const onSiteType =
                document.getElementById("onSiteSupportType");


            if (appointmentDate) {
                appointmentDate.value = "";
            }

            if (appointmentTime) {
                appointmentTime.value = "";
            }

            if (onSiteType) {
                onSiteType.value = "";
            }

            if (appointmentDurationInput) {
                appointmentDurationInput.value = "";
                appointmentDurationInput.min = "1";
                appointmentDurationInput.placeholder =
                    "Select an on-site support type";
            }

            if (durationField) {
                durationField.style.display = "none";
            }

            return;

        }


        const selectedType =
            onSiteSupportTypeSelect?.value || "";

        const settings =
            getOnSiteDurationSettings(selectedType);


        if (durationField) {
            durationField.style.display =
                settings ? "block" : "none";
        }

        if (durationLabel) {
            const labelSuffix = settings?.unit === "days" ? "days" : "hours";
            durationLabel.textContent = `Duration (${labelSuffix})`;
        }

        if (appointmentDurationInput) {
            if (settings) {
                appointmentDurationInput.min =
                    String(settings.minValue ?? settings.minHours ?? 1);
                appointmentDurationInput.step =
                    settings.step || "0.5";
                appointmentDurationInput.placeholder =
                    settings.unit === "days"
                        ? "Enter duration in days"
                        : settings.label;
            } else {
                appointmentDurationInput.value = "";
                appointmentDurationInput.min = "1";
                appointmentDurationInput.step = "0.5";
                appointmentDurationInput.placeholder =
                    "Select an on-site support type";
            }
        }

    }


    supportTypeSelect.addEventListener(
        "change",
        updateAppointmentFields
    );

    if (onSiteSupportTypeSelect) {
        onSiteSupportTypeSelect.addEventListener(
            "change",
            updateAppointmentFields
        );
    }


    // Run when page first loads
    updateAppointmentFields();

}


/* =========================================================
   SUBMIT TICKET
========================================================= */

if (ticketForm) {

    ticketForm.addEventListener(
        "submit",
        async function (event) {

            event.preventDefault();


            const supportType =
                String(
                    document.getElementById("supportType")?.value || ""
                ).trim();

            const onSiteSupportType =
                String(
                    document.getElementById("onSiteSupportType")?.value || ""
                ).trim();

            const isOnSite =
                supportType.toLowerCase() ===
                "on-site support";


            /* -----------------------------------------
               APPOINTMENT VALUES
            ----------------------------------------- */

            let appointmentDate = null;
            let appointmentTime = null;
            let appointmentDuration = null;


            if (isOnSite) {

                if (!onSiteSupportType) {
                    alert(
                        "Please select an on-site support type before submitting the ticket."
                    );
                    return;
                }

                const onSiteSettings =
                    getOnSiteDurationSettings(onSiteSupportType);

                if (!onSiteSettings) {
                    alert(
                        "Please select a valid on-site support type."
                    );
                    return;
                }

                appointmentDate =
                    document.getElementById(
                        "appointmentDate"
                    )?.value || null;


                appointmentTime =
                    document.getElementById(
                        "appointmentTime"
                    )?.value || null;


                appointmentDuration =
                    document.getElementById(
                        "appointmentDuration"
                    )?.value || null;

                const appointmentValidationMessage = validateAppointmentDateTime(
                    appointmentDate,
                    appointmentTime
                );

                if (appointmentValidationMessage) {
                    alert(appointmentValidationMessage);
                    return;
                }

                const rawDuration = Number(appointmentDuration);

                if (onSiteSupportType === "Project") {
                    if (
                        !appointmentDuration ||
                        !Number.isFinite(rawDuration) ||
                        !Number.isInteger(rawDuration) ||
                        rawDuration < 1
                    ) {
                        alert(
                            "Project duration is required and must be a whole number of days (minimum 1 day)."
                        );
                        return;
                    }

                    appointmentDuration = String(rawDuration);
                } else {
                    const roundedDuration = roundUpToHalfHour(rawDuration);

                    if (
                        !appointmentDuration ||
                        !Number.isFinite(rawDuration) ||
                        rawDuration < onSiteSettings.minHours
                    ) {
                        alert(
                            `Duration is required for ${onSiteSupportType} and must be at least ${onSiteSettings.minHours} hour(s).`
                        );
                        return;
                    }

                    if (
                        !Number.isInteger(rawDuration * 2)
                    ) {
                        const updatedDuration =
                            roundedDuration ?? rawDuration;

                        document.getElementById("appointmentDuration").value =
                            String(updatedDuration);

                        appointmentDuration = String(updatedDuration);

                        alert(
                            `Duration was rounded up from ${rawDuration} hour(s) to ${updatedDuration} hour(s). This increases the credit cost to ${updatedDuration} credit(s).`
                        );
                    }
                }

            }


            /* -----------------------------------------
               TICKET DATA
            ----------------------------------------- */

            const ticket = {

                customerName:
                    document.getElementById(
                        "customerName"
                    )?.value || "",


                email:
                    document.getElementById(
                        "email"
                    )?.value || "",


                issue:
                    document.getElementById(
                        "issue"
                    )?.value || "",


                priority:
                    document.getElementById(
                        "priority"
                    )?.value || "",


                supportType:
                    supportType,


                onSiteSupportType:
                    isOnSite ? onSiteSupportType : "",


                appointmentDate:
                    appointmentDate,


                appointmentTime:
                    appointmentTime,


                appointmentDuration:
                    appointmentDuration

            };


            console.log(
                "Submitting ticket:",
                ticket
            );


            try {

                const response =
                    await fetch(
                        "/api/tickets",
                        {

                            method: "POST",

                            headers: {
                                "Content-Type":
                                    "application/json"
                            },

                            body:
                                JSON.stringify(ticket)

                        }
                    );


                const result =
                    await response.json();


                if (response.ok) {

                    const ticketMessage =
                        document.getElementById(
                            "ticketMessage"
                        );


                    if (ticketMessage) {

                        ticketMessage.textContent =
                            `Ticket created successfully! Ticket ID: ${result.ticketId}`;

                    } else {

                        alert(
                            `Ticket created successfully!\nTicket ID: ${result.ticketId}`
                        );

                    }


                    ticketForm.reset();


                    if (onSiteSupportTypeSelect) {
                        onSiteSupportTypeSelect.value = "";
                    }

                    if (appointmentDurationInput) {
                        appointmentDurationInput.value = "";
                        appointmentDurationInput.min = "1";
                        appointmentDurationInput.placeholder =
                            "Select an on-site support type";
                    }

                    if (durationField) {
                        durationField.style.display = "none";
                    }


                    // Hide appointment section again
                    if (appointmentSection) {

                        appointmentSection.style.display =
                            "none";

                    }


                } else {

                    alert(
                        result.message ||
                        "Failed to create ticket."
                    );

                }


            } catch (error) {

                console.error(
                    "Ticket creation error:",
                    error
                );


                alert(
                    "Unable to connect to the server."
                );

            }

        }
    );

}


/* =========================================================
   STAFF DASHBOARD
========================================================= */

const ticketTableBody =
    document.getElementById("ticketTableBody");

if (ticketTableBody) {

    loadStaffDashboard();

}


async function deleteTicketWithConfirmation(ticketId) {
    if (!ticketId) {
        alert("Ticket ID not found.");
        return false;
    }

    if (!window.confirm("Are you sure you want to delete this ticket?")) {
        return false;
    }

    try {
        const response = await fetch(
            `/api/tickets/${encodeURIComponent(ticketId)}`,
            { method: "DELETE" }
        );
        const result = await response.json();

        if (!response.ok) {
            alert(result.message || "Failed to delete ticket.");
            return false;
        }

        alert(result.message || "Ticket deleted successfully.");
        return true;
    } catch (error) {
        console.error("Delete ticket error:", error);
        alert("Unable to connect to the server.");
        return false;
    }
}


async function loadStaffDashboard() {

    try {

        const response =
            await fetch("/api/tickets");

        const tickets =
            await response.json();


        if (!response.ok) {

            throw new Error(
                "Failed to load tickets."
            );

        }


        const totalTickets =
            document.getElementById("totalTickets");

        const openTickets =
            document.getElementById("openTickets");

        const inProgressTickets =
            document.getElementById("inProgressTickets");

        const closedTickets =
            document.getElementById("closedTickets");

        const emptyState =
            document.getElementById("emptyState");

        const mobileTicketList =
            document.getElementById("mobileTicketList");


        const ticketCounts = countTicketStatuses(tickets);

        if (totalTickets) {
            totalTickets.textContent = ticketCounts.total;
        }

        if (openTickets) {
            openTickets.textContent = ticketCounts.open;
        }

        if (inProgressTickets) {
            inProgressTickets.textContent = ticketCounts.inProgress;
        }

        if (closedTickets) {
            closedTickets.textContent = ticketCounts.closed;
        }


        ticketTableBody.innerHTML = "";

        if (mobileTicketList) {
            mobileTicketList.innerHTML = "";
        }


        if (tickets.length === 0) {

            if (emptyState) {
                emptyState.style.display = "block";
            }

            return;

        }


        if (emptyState) {
            emptyState.style.display = "none";
        }


        let openedSwipe = null;

        function closeOpenedSwipe() {
            if (!openedSwipe) {
                return;
            }

            openedSwipe.entry.classList.remove("is-open");
            openedSwipe.deleteButton.disabled = true;
            openedSwipe = null;
        }

        function revealSwipe(entry, deleteButton) {
            if (openedSwipe && openedSwipe.entry !== entry) {
                closeOpenedSwipe();
            }

            entry.classList.add("is-open");
            deleteButton.disabled = false;
            openedSwipe = { entry, deleteButton };
        }


        tickets.forEach(ticket => {

            const ticketId =
                ticket["Ticket ID"] || ticket.ticketId || "";

            const row =
                document.createElement("tr");

            row.className = "ticket-row";
            row.dataset.ticketId = ticketId;

            const ticketIdCell =
                document.createElement("td");

            ticketIdCell.className = "ticket-id-cell";
            ticketIdCell.textContent = ticketId;

            const customerCell =
                document.createElement("td");
            customerCell.textContent =
                ticket["Customer Name"] || ticket.customerName || "";

            const issueCell =
                document.createElement("td");
            issueCell.textContent =
                ticket.Issue || ticket.issue || "";

            const supportTypeCell =
                document.createElement("td");
            supportTypeCell.textContent =
                ticket["Support Type"] || ticket.supportType || "";

            const statusCell =
                document.createElement("td");
            statusCell.textContent =
                ticket.Status || ticket.status || "";

            const actionCell =
                document.createElement("td");

            const deleteButton =
                document.createElement("button");

            deleteButton.type = "button";
            deleteButton.className = "delete-ticket-btn";
            deleteButton.textContent = "Delete";

            deleteButton.addEventListener("click", async event => {
                event.preventDefault();
                event.stopPropagation();

                if (await deleteTicketWithConfirmation(ticketId)) {
                    location.reload();
                }
            });

            actionCell.appendChild(deleteButton);

            row.append(
                ticketIdCell,
                customerCell,
                issueCell,
                supportTypeCell,
                statusCell,
                actionCell
            );

            row.addEventListener("click", event => {
                if (event.target.closest("button")) {
                    return;
                }

                if (!ticketId) {
                    return;
                }

                window.location.href =
                    `/ticket-details.html?ticketId=${encodeURIComponent(ticketId)}`;
            });

            ticketTableBody.appendChild(row);

            if (mobileTicketList) {
                const swipeEntry = document.createElement("div");
                swipeEntry.className = "mobile-ticket-swipe";

                const mobileDeleteButton = document.createElement("button");
                mobileDeleteButton.type = "button";
                mobileDeleteButton.className = "mobile-ticket-delete";
                mobileDeleteButton.textContent = "Delete";
                mobileDeleteButton.setAttribute(
                    "aria-label",
                    `Delete ticket ${ticketId}`
                );
                mobileDeleteButton.disabled = true;
                mobileDeleteButton.addEventListener("click", async event => {
                    event.preventDefault();
                    event.stopPropagation();

                    if (await deleteTicketWithConfirmation(ticketId)) {
                        location.reload();
                    }
                });
                mobileDeleteButton.addEventListener("keydown", event => {
                    if (event.key === "Escape") {
                        closeOpenedSwipe();
                        mobileCard.focus();
                    }
                });

                const mobileCard = document.createElement("a");
                mobileCard.className = "mobile-ticket-card";
                mobileCard.href = `/ticket-details.html?ticketId=${encodeURIComponent(ticketId)}`;
                mobileCard.setAttribute("aria-label", `Open ticket ${ticketId}`);

                const mobileInfo = document.createElement("span");
                mobileInfo.className = "mobile-ticket-info";

                const mobileId = document.createElement("strong");
                mobileId.textContent = ticketId;

                const mobileIssue = document.createElement("span");
                mobileIssue.className = "mobile-ticket-issue";
                mobileIssue.textContent = ticket.Issue || ticket.issue || "";

                const mobileMeta = document.createElement("span");
                mobileMeta.className = "mobile-ticket-meta";
                mobileMeta.textContent = [
                    ticket["Customer Name"] || ticket.customerName || "",
                    ticket["Support Type"] || ticket.supportType || ""
                ].filter(Boolean).join(" · ");

                const mobileStatus = document.createElement("span");
                mobileStatus.className = "status mobile-ticket-status";
                mobileStatus.textContent = ticket.Status || ticket.status || "";

                mobileInfo.append(mobileId, mobileIssue, mobileMeta);
                mobileCard.append(mobileInfo, mobileStatus);
                swipeEntry.append(mobileDeleteButton, mobileCard);

                let pointerStart = null;
                let pointerCurrentX = null;
                let swipeDetected = false;
                let suppressClickUntil = 0;

                mobileCard.addEventListener("keydown", event => {
                    if (event.key === "ArrowLeft") {
                        event.preventDefault();
                        revealSwipe(swipeEntry, mobileDeleteButton);
                        mobileDeleteButton.focus();
                    }
                });

                mobileCard.addEventListener("click", event => {
                    if (Date.now() < suppressClickUntil || openedSwipe) {
                        event.preventDefault();
                        closeOpenedSwipe();
                    }
                });

                mobileCard.addEventListener("pointerdown", event => {
                    if (event.pointerType === "mouse" && event.button !== 0) {
                        return;
                    }

                    mobileCard.setPointerCapture(event.pointerId);
                    swipeEntry.classList.add("is-dragging");
                    pointerCurrentX = event.clientX;
                    pointerStart = {
                        x: event.clientX,
                        y: event.clientY,
                        wasOpen: swipeEntry.classList.contains("is-open")
                    };
                    swipeDetected = false;
                });

                mobileCard.addEventListener("pointermove", event => {
                    if (!pointerStart) {
                        return;
                    }

                    const deltaX = event.clientX - pointerStart.x;
                    const deltaY = event.clientY - pointerStart.y;
                    pointerCurrentX = event.clientX;

                    if (
                        !swipeDetected &&
                        Math.abs(deltaX) > 8 &&
                        Math.abs(deltaX) > Math.abs(deltaY)
                    ) {
                        swipeDetected = true;
                    }

                    if (!swipeDetected) {
                        return;
                    }

                    event.preventDefault();
                    const offset = Math.max(
                        -88,
                        Math.min(0, (pointerStart.wasOpen ? -88 : 0) + deltaX)
                    );
                    mobileCard.style.transform = `translateX(${offset}px)`;
                });

                mobileCard.addEventListener("pointerup", event => {
                    if (!pointerStart) {
                        return;
                    }

                    const deltaX = event.clientX - pointerStart.x;
                    if (swipeDetected) {
                        if (deltaX < -40) {
                            revealSwipe(swipeEntry, mobileDeleteButton);
                        } else if (deltaX > 40) {
                            closeOpenedSwipe();
                        }

                        suppressClickUntil = Date.now() + 350;
                    }

                    pointerStart = null;
                    pointerCurrentX = null;
                    swipeEntry.classList.remove("is-dragging");
                    mobileCard.style.transform = "";
                });

                mobileCard.addEventListener("pointercancel", () => {
                    if (pointerStart && swipeDetected) {
                        const deltaX = pointerCurrentX - pointerStart.x;
                        if (deltaX < -40) {
                            revealSwipe(swipeEntry, mobileDeleteButton);
                        } else if (deltaX > 40) {
                            closeOpenedSwipe();
                        }

                        suppressClickUntil = Date.now() + 350;
                    }

                    pointerStart = null;
                    pointerCurrentX = null;
                    swipeEntry.classList.remove("is-dragging");
                    mobileCard.style.transform = "";
                });

                mobileTicketList.appendChild(swipeEntry);
            }

        });

        if (mobileTicketList) {
            mobileTicketList.addEventListener("click", event => {
                if (openedSwipe && !openedSwipe.entry.contains(event.target)) {
                    closeOpenedSwipe();
                }
            });
        }


    } catch (error) {

        console.error(
            "Dashboard error:",
            error
        );

    }

}


/* =========================================================
   STAFF PROFILE
========================================================= */

const profileName =
    document.getElementById("profileName");

if (profileName) {

    loadStaffProfile();

}


async function loadStaffProfile() {
    try {
        const response = await fetch("/api/staff/profile");
        const data = await response.json();

        if (response.status === 401) {
            localStorage.removeItem("staff");
            window.location.href = "/staff-login.html";
            return;
        }

        if (!response.ok) {
            throw new Error(data.message || "Unable to load staff profile.");
        }

        displayStaffProfile(data.staff);
    } catch (error) {
        console.error("Staff profile error:", error);
        const status = document.getElementById("profileStatus");
        if (status) {
            status.textContent = "Unable to load your profile. Please try again.";
            status.setAttribute("role", "alert");
        }
    }
}

function displayStaffProfile(staff) {
    const fields = {
        profileName: staff.name,
        profileDepartment: staff.department,
        staffName: staff.name,
        staffEmail: staff.email,
        staffRole: staff.role,
        staffDepartment: staff.department
    };

    Object.entries(fields).forEach(([id, value]) => {
        const element = document.getElementById(id);
        if (element) {
            element.textContent = value || "";
        }
    });

    localStorage.setItem("staff", JSON.stringify(staff));

    const editProfileButton = document.getElementById("editProfileButton");
    if (editProfileButton) {
        editProfileButton.hidden = false;
    }
}

const editProfileForm = document.getElementById("editProfileForm");

if (editProfileForm) {
    const editProfileButton = document.getElementById("editProfileButton");
    const cancelProfileButton = document.getElementById("cancelProfileButton");
    const saveProfileButton = document.getElementById("saveProfileButton");
    const editStaffName = document.getElementById("editStaffName");
    const currentStaffPassword = document.getElementById("currentStaffPassword");
    const newStaffPassword = document.getElementById("newStaffPassword");
    const confirmStaffPassword = document.getElementById("confirmStaffPassword");
    const editProfileStatus = document.getElementById("editProfileStatus");
    const profileStatus = document.getElementById("profileStatus");

    editProfileButton.addEventListener("click", () => {
        editStaffName.value = document.getElementById("staffName").textContent;
        editProfileStatus.textContent = "";
        profileStatus.textContent = "";
        editProfileForm.hidden = false;
        editProfileButton.hidden = true;
        editStaffName.focus();
    });

    cancelProfileButton.addEventListener("click", () => {
        editProfileForm.reset();
        editProfileForm.hidden = true;
        editProfileButton.hidden = false;
        editProfileStatus.textContent = "";
    });

    editProfileForm.addEventListener("submit", async event => {
        event.preventDefault();
        editProfileStatus.textContent = "";

        const currentPassword = currentStaffPassword.value;
        const newPassword = newStaffPassword.value;
        const confirmPassword = confirmStaffPassword.value;
        const changingPassword = Boolean(currentPassword || newPassword || confirmPassword);

        if (changingPassword && (!currentPassword || !newPassword || !confirmPassword)) {
            editProfileStatus.textContent = "Enter your current password and the new password twice.";
            return;
        }

        if (changingPassword && newPassword !== confirmPassword) {
            editProfileStatus.textContent = "The new passwords do not match.";
            confirmStaffPassword.focus();
            return;
        }

        saveProfileButton.disabled = true;
        try {
            const response = await fetch("/api/staff/profile", {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: editStaffName.value,
                    currentPassword,
                    newPassword,
                    confirmPassword
                })
            });
            const data = await response.json();

            if (response.status === 401) {
                localStorage.removeItem("staff");
                window.location.href = "/staff-login.html";
                return;
            }

            if (!response.ok) {
                editProfileStatus.textContent = data.message || "Unable to update your profile.";
                return;
            }

            displayStaffProfile(data.staff);
            editProfileForm.reset();
            editProfileForm.hidden = true;
            editProfileButton.hidden = false;
            profileStatus.textContent = data.message;
        } catch (error) {
            console.error("Update staff profile error:", error);
            editProfileStatus.textContent = "Unable to update your profile. Please try again.";
        } finally {
            saveProfileButton.disabled = false;
        }
    });
}

document.querySelectorAll(".staff-logout").forEach(link => {
    link.addEventListener("click", async event => {
        event.preventDefault();
        try {
            await fetch("/api/staff/logout", { method: "POST" });
        } catch (error) {
            console.error("Staff logout error:", error);
        } finally {
            localStorage.removeItem("staff");
            window.location.href = "/";
        }
    });
});


/* =========================================================
   TICKET DETAILS
========================================================= */

const ticketIdElement =
    document.getElementById("ticketId");

if (ticketIdElement) {

    loadTicketDetails();

}


async function loadTicketDetails() {

    const params =
        new URLSearchParams(
            window.location.search
        );


    const ticketId =
        params.get("ticketId");


    if (!ticketId) {

        alert("No ticket ID was provided.");

        return;

    }


    try {

        const response =
            await fetch(
                `/api/tickets/${encodeURIComponent(ticketId)}`
            );


        const ticket =
            await response.json();


        if (!response.ok) {

            throw new Error(
                ticket.message ||
                "Failed to load ticket."
            );

        }


        /* -----------------------------------------
           LOAD NORMAL TICKET INFORMATION
        ----------------------------------------- */

        setField(
            "ticketId",
            ticket["Ticket ID"] || ticket.ticketId
        );

        setField(
            "customerId",
            ticket["Customer ID"] || ticket.customerId
        );

        setField(
            "customerName",
            ticket["Customer Name"] || ticket.customerName
        );

        setField(
            "customerEmail",
            ticket.Email || ticket.email
        );

        setField(
            "issue",
            ticket.Issue || ticket.issue
        );

        const supportTypeValue =
            ticket["Support Type"] || ticket.supportType || "";

        setField(
            "supportType",
            supportTypeValue
        );

        const isOnSiteTicket =
            String(supportTypeValue).trim().toLowerCase() ===
            "on-site support";

        toggleOnSiteTicketFields(isOnSiteTicket);
        updateAssignedRoleLabel(supportTypeValue);

        setField(
            "appointmentDate",
            formatDisplayDate(
                ticket["Appointment Date"] || ticket.appointmentDate
            )
        );

        setField(
            "appointmentTime",
            ticket["Appointment Time"] || ticket.appointmentTime
        );

        const createdTimestamp =
            ticket["Created Date"] || ticket.createdDate || "";

        setField(
            "createdDate",
            formatCreatedTimestamp(createdTimestamp)
        );


        /* -----------------------------------------
           LOAD ENGINEERS
        ----------------------------------------- */

        await loadEngineers(
            ticket["Assigned Engineer"] ||
            ticket.assignedEngineer ||
            ""
        );


        /* -----------------------------------------
           LOAD OTHER EDITABLE FIELDS
        ----------------------------------------- */

        setField(
            "status",
            ticket.Status || ticket.status
        );

        setField(
            "appointmentStatus",
            ticket["Appointment Status"] ||
            ticket.appointmentStatus
        );

        setField(
            "serviceResult",
            ticket["Service Result"] ||
            ticket.serviceResult
        );


        const ticketStatus =
            document.getElementById("ticketStatus");

        if (ticketStatus) {

            ticketStatus.textContent =
                ticket.Status ||
                ticket.status ||
                "";

        }

        await refreshServiceReportButtonState();

    } catch (error) {

        console.error(
            "Ticket details error:",
            error
        );

        alert(
            "Unable to load ticket details."
        );

    }

}


/* =========================================================
   SERVICE REPORT FLOW
========================================================= */

let currentServiceReport = null;
let serviceReportFormMode = "create";

function normalizeServiceMode(value) {
    const normalized = String(value || "").trim();
    const lowerValue = normalized.toLowerCase();

    if (["on-site", "onsite", "on site", "yes", "yes (on-site)", "visit", "on-site visit"].includes(lowerValue)) {
        return "On-site";
    }

    if (["remote", "remote support", "off-site", "offsite", "no"].includes(lowerValue)) {
        return "Remote";
    }

    if (["hybrid", "hybrid support"].includes(lowerValue)) {
        return "Hybrid";
    }

    return "On-site";
}

function getCurrentTicketId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("ticketId") || "";
}

async function fetchServiceReportsForTicket(ticketId) {
    if (!ticketId) {
        return [];
    }

    const response = await fetch(
        `/api/tickets/${encodeURIComponent(ticketId)}/service-reports`
    );

    if (!response.ok) {
        throw new Error("Failed to load service report.");
    }

    const reports = await response.json();
    return Array.isArray(reports) ? reports : [];
}

async function refreshServiceReportButtonState() {
    const button = document.getElementById("serviceReportActionButton");
    const ticketId = getCurrentTicketId();

    if (!button || !ticketId) {
        return;
    }

    try {
        const reports = await fetchServiceReportsForTicket(ticketId);
        const report = reports.length > 0 ? reports[reports.length - 1] : null;

        currentServiceReport = report;
        button.textContent = report ? "View Service Report" : "Create Service Report";
        button.onclick = () => {
            if (report) {
                viewSavedReport();
            } else {
                openCreateServiceReportForm();
            }
        };

    } catch (error) {
        console.error("Service report state error:", error);
        button.textContent = "Create Service Report";
        button.onclick = openCreateServiceReportForm;
    }
}

async function viewSavedReport() {
    const ticketId = getCurrentTicketId();

    if (!ticketId) {
        alert("Ticket ID not found.");
        return;
    }

    try {
        const reports = await fetchServiceReportsForTicket(ticketId);

        if (!Array.isArray(reports) || reports.length === 0) {
            openCreateServiceReportForm();
            return;
        }

        const report = reports[reports.length - 1];
        currentServiceReport = report;

        const modal = document.getElementById("reportModal");

        if (!modal) {
            alert("Service report modal is unavailable.");
            return;
        }

        const repTicketId = document.getElementById("repTicketId");
        const repCustomer = document.getElementById("repCustomer");
        const repEmail = document.getElementById("repEmail");
        const repIssue = document.getElementById("repIssue");
        const repSupportType = document.getElementById("repSupportType");
        const repEngineer = document.getElementById("repEngineer");
        const repEngineerLabel = document.getElementById("repEngineerLabel");
        const repOnsite = document.getElementById("repOnsite");
        const repDate = document.getElementById("repDate");
        const repTime = document.getElementById("repTime");
        const repHours = document.getElementById("repHours");
        const repTasks = document.getElementById("repTasks");
        const repResolution = document.getElementById("repResolution");

        if (repTicketId) {
            repTicketId.textContent = report["Ticket ID"] || ticketId;
        }

        if (repCustomer) {
            repCustomer.textContent = `${report["Customer Name"] || ""} (${report["Customer ID"] || ""})`;
        }

        if (repEmail) {
            repEmail.textContent = report.Email || report["Customer Email"] || "-";
        }

        if (repIssue) {
            repIssue.textContent = report.Issue || report["Reported Issue"] || "-";
        }

        if (repSupportType) {
            repSupportType.textContent = report["Support Type"] || report.supportType || "-";
        }

        if (repEngineerLabel) {
            repEngineerLabel.textContent = getAssignmentRoleLabel(report["Support Type"] || report.supportType || "");
        }

        if (repEngineer) {
            repEngineer.textContent = report.Engineer || report["Assigned Engineer"] || "-";
        }

        if (repOnsite) {
            repOnsite.textContent = normalizeServiceMode(report.ServiceMode || report.Onsite || report["Service Mode"] || "");
        }

        if (repDate) {
            repDate.textContent = formatDisplayDate(report.Date) || "-";
        }

        if (repTime) {
            repTime.textContent = `${report.SignInTime || "-"} to ${report.SignOutTime || "-"}`;
        }

        if (repHours) {
            repHours.textContent = `${report.HoursSpent || 0} Hours`;
        }

        if (repTasks) {
            repTasks.textContent = report.TasksDone || "-";
        }

        if (repResolution) {
            repResolution.textContent = report.Resolution || "-";
        }

        modal.style.display = "flex";

    } catch (error) {
        console.error("Failed to load report:", error);
        alert("Error loading service report.");
    }
}

function closeServiceReportModal() {
    const modal = document.getElementById("reportModal");
    if (modal) {
        modal.style.display = "none";
    }
}

function closeServiceReportFormModal() {
    const modal = document.getElementById("serviceReportFormModal");
    if (modal) {
        modal.style.display = "none";
    }
}

async function populateServiceReportEngineerOptions(currentEngineer = "") {
    const select = document.getElementById("reportEngineer");

    if (!select) {
        return;
    }

    try {
        const response = await fetch("/api/staff");

        if (!response.ok) {
            throw new Error("Failed to load staff.");
        }

        const staff = await response.json();
        select.innerHTML = '<option value="">Unassigned</option>';

        staff.forEach(person => {
            const option = document.createElement("option");
            option.value = person.name;
            option.textContent = person.name;

            if (person.name === currentEngineer) {
                option.selected = true;
            }

            select.appendChild(option);
        });

        if (currentEngineer) {
            select.value = currentEngineer;
        }

    } catch (error) {
        console.error("Error loading report engineers:", error);
    }
}

function getServiceReportDefaults() {
    const today = new Date().toISOString().split("T")[0];
    const ticketAssignedEngineer = document.getElementById("assignedEngineer")?.value || "";
    const supportType = document.getElementById("supportType")?.textContent || "";
    const inferredMode = String(supportType).trim().toLowerCase() === "on-site support"
        ? "On-site"
        : "Remote";

    return {
        date: today,
        engineer: ticketAssignedEngineer,
        serviceMode: inferredMode
    };
}

async function openCreateServiceReportForm() {
    const ticketId = getCurrentTicketId();

    if (!ticketId) {
        alert("Ticket ID not found.");
        return;
    }

    serviceReportFormMode = "create";
    currentServiceReport = null;

    const form = document.getElementById("serviceReportForm");
    const modal = document.getElementById("serviceReportFormModal");
    const title = document.getElementById("serviceReportFormTitle");
    const submitButton = document.getElementById("serviceReportSubmitButton");

    if (!form || !modal || !title || !submitButton) {
        alert("Service report form is unavailable.");
        return;
    }

    form.reset();
    title.textContent = "Create Service Report";
    submitButton.textContent = "Submit Service Report";

    const defaults = getServiceReportDefaults();
    document.getElementById("reportServiceMode").value = defaults.serviceMode;
    document.getElementById("reportDate").value = defaults.date;
    await populateServiceReportEngineerOptions(defaults.engineer);

    modal.style.display = "flex";
}

async function openEditServiceReportForm() {
    if (!currentServiceReport) {
        alert("No service report is selected.");
        return;
    }

    serviceReportFormMode = "edit";

    const form = document.getElementById("serviceReportForm");
    const modal = document.getElementById("serviceReportFormModal");
    const title = document.getElementById("serviceReportFormTitle");
    const submitButton = document.getElementById("serviceReportSubmitButton");

    if (!form || !modal || !title || !submitButton) {
        alert("Service report form is unavailable.");
        return;
    }

    form.reset();
    title.textContent = "Edit Service Report";
    submitButton.textContent = "Save Changes";

    document.getElementById("reportServiceMode").value = normalizeServiceMode(currentServiceReport.ServiceMode || currentServiceReport.Onsite || currentServiceReport["Service Mode"] || "");
    document.getElementById("reportDate").value = currentServiceReport.Date || new Date().toISOString().split("T")[0];
    document.getElementById("reportSignInTime").value = currentServiceReport.SignInTime || "";
    document.getElementById("reportSignOutTime").value = currentServiceReport.SignOutTime || "";
    document.getElementById("reportTasksDone").value = currentServiceReport.TasksDone || "";
    document.getElementById("reportResolution").value = currentServiceReport.Resolution || "";

    await populateServiceReportEngineerOptions(currentServiceReport.Engineer || currentServiceReport["Assigned Engineer"] || "");

    closeServiceReportModal();
    modal.style.display = "flex";
}

async function submitServiceReportForm(event) {
    event.preventDefault();

    const ticketId = getCurrentTicketId();

    if (!ticketId) {
        alert("Ticket ID not found.");
        return;
    }

    const serviceMode = document.getElementById("reportServiceMode").value || "On-site";
    const payload = {
        serviceMode,
        onsite: serviceMode === "On-site" || serviceMode === "Hybrid",
        engineer: document.getElementById("reportEngineer").value || "",
        date: document.getElementById("reportDate").value || "",
        signInTime: document.getElementById("reportSignInTime").value || "",
        signOutTime: document.getElementById("reportSignOutTime").value || "",
        tasksDone: document.getElementById("reportTasksDone").value.trim(),
        resolution: document.getElementById("reportResolution").value.trim()
    };

    if (!payload.date) {
        alert("Please select a service date.");
        return;
    }

    const method = serviceReportFormMode === "edit" ? "PUT" : "POST";
    const endpoint = `/api/tickets/${encodeURIComponent(ticketId)}/service-report`;

    try {
        const response = await fetch(endpoint, {
            method,
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "Unable to save the service report.");
        }

        closeServiceReportFormModal();
        await refreshServiceReportButtonState();
        await viewSavedReport();
        alert(data.message || "Service report saved successfully.");

    } catch (error) {
        console.error("Service report save error:", error);
        alert(error.message || "Unable to save the service report.");
    }
}

async function deleteCurrentServiceReport() {
    const ticketId = getCurrentTicketId();

    if (!ticketId) {
        alert("Ticket ID not found.");
        return;
    }

    if (!currentServiceReport) {
        alert("No service report is available to delete.");
        return;
    }

    const confirmed = window.confirm("Delete this service report?");
    if (!confirmed) {
        return;
    }

    try {
        const response = await fetch(`/api/tickets/${encodeURIComponent(ticketId)}/service-report`, {
            method: "DELETE"
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.message || "Unable to delete the service report.");
        }

        closeServiceReportModal();
        currentServiceReport = null;
        await refreshServiceReportButtonState();
        alert(data.message || "Service report deleted successfully.");

    } catch (error) {
        console.error("Delete service report error:", error);
        alert(error.message || "Unable to delete the service report.");
    }
}

const serviceReportForm = document.getElementById("serviceReportForm");
if (serviceReportForm) {
    serviceReportForm.addEventListener("submit", submitServiceReportForm);
}


/* =========================================================
   LOAD ENGINEERS
========================================================= */

async function loadEngineers(currentEngineer = "") {

    const engineerSelect =
        document.getElementById("assignedEngineer");


    if (!engineerSelect) {
        return;
    }


    try {

        const response =
            await fetch("/api/staff");


        if (!response.ok) {

            throw new Error(
                "Failed to load staff."
            );

        }


        const staff =
            await response.json();


        /* Clear existing options */

        engineerSelect.innerHTML = "";


        /* Unassigned option */

        const unassignedOption =
            document.createElement("option");

        unassignedOption.value = "";

        unassignedOption.textContent =
            "Unassigned";

        engineerSelect.appendChild(
            unassignedOption
        );


        /* Add staff members */

        staff.forEach(person => {

            const option =
                document.createElement("option");


            option.value =
                person.name;

            option.textContent =
                person.name;


            /* Keep currently assigned engineer selected */

            if (
                person.name === currentEngineer
            ) {

                option.selected = true;

            }


            engineerSelect.appendChild(
                option
            );

        });


    } catch (error) {

        console.error(
            "Error loading engineers:",
            error
        );

    }

}


/* =========================================================
   SET FIELD
========================================================= */

function setField(id, value) {

    const element =
        document.getElementById(id);


    if (!element) {
        return;
    }


    if (
        element.tagName === "INPUT" ||
        element.tagName === "TEXTAREA" ||
        element.tagName === "SELECT"
    ) {

        element.value =
            value ?? "";

    } else {

        element.textContent =
            value ?? "";

    }

}


function formatDisplayDate(value) {

    if (!value) {
        return "";
    }

    if (typeof value === "string" && /^\d{2}-\d{2}-\d{4}$/.test(value.trim())) {
        return value.trim();
    }

    const dateOnly = typeof value === "string" ? value.trim() : "";
    const isoMatch = dateOnly.match(/^\d{4}-\d{2}-\d{2}$/);
    const parsedDate = isoMatch
        ? new Date(Date.UTC(
            Number(isoMatch[0].slice(0, 4)),
            Number(isoMatch[0].slice(5, 7)) - 1,
            Number(isoMatch[0].slice(8, 10))
        ))
        : new Date(value);

    if (Number.isNaN(parsedDate.getTime())) {
        return String(value);
    }

    const day = String(parsedDate.getUTCDate()).padStart(2, "0");
    const month = String(parsedDate.getUTCMonth() + 1).padStart(2, "0");
    const year = parsedDate.getUTCFullYear();

    return `${day}-${month}-${year}`;

}


function formatCreatedTimestamp(value) {

    if (!value) {
        return "";
    }

    const parsedDate = new Date(value);

    if (Number.isNaN(parsedDate.getTime())) {
        return String(value);
    }

    const day = String(parsedDate.getUTCDate()).padStart(2, "0");
    const month = String(parsedDate.getUTCMonth() + 1).padStart(2, "0");
    const year = parsedDate.getUTCFullYear();
    const hours = String(parsedDate.getUTCHours()).padStart(2, "0");
    const minutes = String(parsedDate.getUTCMinutes()).padStart(2, "0");

    return `${day}-${month}-${year} | ${hours}:${minutes}`;

}


function getAssignmentRoleLabel(supportTypeValue) {

    return String(supportTypeValue || "").trim().toLowerCase() ===
        "on-site support"
        ? "Assigned Technician"
        : "Assigned Engineer";

}


function updateAssignedRoleLabel(supportTypeValue) {

    const labelElement =
        document.getElementById("assignedRoleLabel");

    if (labelElement) {
        labelElement.textContent =
            getAssignmentRoleLabel(supportTypeValue);
    }

    const reportLabelElement =
        document.getElementById("repEngineerLabel");

    if (reportLabelElement) {
        reportLabelElement.textContent =
            getAssignmentRoleLabel(supportTypeValue);
    }

}


function toggleOnSiteTicketFields(isOnSiteTicket) {

    const onSiteRows = [
        document.getElementById("appointmentDateRow"),
        document.getElementById("appointmentTimeRow")
    ];

    const onSiteControls = [
        document.getElementById("appointmentStatusGroup")
    ];


    onSiteRows.forEach(element => {
        if (element) {
            element.style.display =
                isOnSiteTicket ? "grid" : "none";
        }
    });

    onSiteControls.forEach(element => {
        if (element) {
            element.style.display =
                isOnSiteTicket ? "block" : "none";
        }
    });

}


/* =========================================================
   SAVE TICKET CHANGES
========================================================= */

async function saveChanges() {

    const params =
        new URLSearchParams(
            window.location.search
        );


    const ticketId =
        params.get("ticketId");


    if (!ticketId) {

        alert("Ticket ID not found.");

        return;

    }


    const supportTypeValue =
        document.getElementById("supportType")?.textContent || "";

    const isOnSiteTicket =
        String(supportTypeValue).trim().toLowerCase() ===
        "on-site support";

    const updatedTicket = {

        status:
            document.getElementById("status")?.value || "",

        assignedEngineer:
            document.getElementById("assignedEngineer")?.value || "",

        appointmentStatus:
            isOnSiteTicket
                ? document.getElementById("appointmentStatus")?.value || ""
                : "",

        serviceResult:
            document.getElementById("serviceResult")?.value || ""

    };


    try {

        const response =
            await fetch(
                `/api/tickets/${encodeURIComponent(ticketId)}`,
                {

                    method: "PUT",

                    headers: {
                        "Content-Type": "application/json"
                    },

                    body:
                        JSON.stringify(updatedTicket)

                }
            );


        const result =
            await response.json();


        if (response.ok) {

            alert(
                result.message ||
                "Ticket updated successfully."
            );

            location.reload();

        } else {

            alert(
                result.message ||
                "Failed to update ticket."
            );

        }


    } catch (error) {

        console.error(
            "Save changes error:",
            error
        );

        alert(
            "Unable to connect to the server."
        );

    }

}


/* =========================================================
   DELETE TICKET
========================================================= */

async function deleteTicket() {

    const params =
        new URLSearchParams(
            window.location.search
        );


    const ticketId =
        params.get("ticketId");


    if (!ticketId) {

        alert("Ticket ID not found.");

        return;

    }


    const confirmed =
        confirm(
            "Are you sure you want to delete this ticket?"
        );


    if (!confirmed) {
        return;
    }


    try {

        const response =
            await fetch(
                `/api/tickets/${encodeURIComponent(ticketId)}`,
                {
                    method: "DELETE"
                }
            );


        const result =
            await response.json();


        if (response.ok) {

            const refundMessage =
                result.refundApplied
                    ? `Customer refunded ${result.refundedCredits ?? 0} credit(s).`
                    : "";

            const successMessage =
                result.message ||
                "Ticket deleted successfully.";

            alert(
                refundMessage
                    ? `${successMessage}\n${refundMessage}`
                    : successMessage
            );

            window.location.href =
                "/staff.html";

        } else {

            alert(
                result.message ||
                "Failed to delete ticket."
            );

        }


    } catch (error) {

        console.error(
            "Delete ticket error:",
            error
        );

        alert(
            "Unable to connect to the server."
        );

    }

}


/* =========================================================
   LOGOUT
========================================================= */

function logoutStaff() {

    localStorage.removeItem("staff");

    window.location.href =
        "/staff-login.html";

}


/*
   CUSTOMER-FACING LOGOUT DISABLED.
   Restore by uncommenting the original block below.
   Original behavior: localStorage.removeItem("customer"); window.location.href = "/customer-login.html";
   // function logoutCustomer() {
   //     localStorage.removeItem("customer");
   //     window.location.href = "/customer-login.html";
   // }
*/
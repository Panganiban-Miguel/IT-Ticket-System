(() => {
    const directory = document.getElementById("staffDirectory");
    const status = document.getElementById("staffDatabaseStatus");
    const createFormSection = document.getElementById("newStaffForm");
    const createForm = document.getElementById("createStaffForm");
    const unassignedAppointments = document.getElementById("unassignedAppointments");
    let staffRecords = [];
    let appointments = [];
    let loginAccounts = [];
    let unassignedTickets = [];

    async function request(url, options = {}) {
        const response = await fetch(url, options);
        const data = response.status === 204 ? {} : await response.json();
        if (response.status === 401) {
            localStorage.removeItem("staff");
            window.location.href = "/staff-login.html";
            throw new Error("Your staff session has expired.");
        }
        if (!response.ok) {
            throw new Error(data.message || "The request could not be completed.");
        }
        return data;
    }

    function addText(parent, tagName, text, className = "") {
        const element = document.createElement(tagName);
        element.textContent = text;
        if (className) element.className = className;
        parent.appendChild(element);
        return element;
    }

    function appointmentLabel(appointment) {
        const project = Number(appointment["Project Days"] || 0) > 0
            ? `Project (${appointment["Project Days"]} ${appointment["Project Day Mode"] || "calendar"} days)`
            : `${appointment["Start Time"] || ""}–${appointment["End Time"] || ""}`;
        return `${appointment["Start Date"] || "Date not set"} ${project} · ${appointment["Ticket ID"] || "Ticket"} · ${appointment.Address || "Address not set"} · ${appointment.Status || "Pending"}`;
    }

    function createAppointmentAssignmentCard(appointment) {
        const card = document.createElement("details");
        card.className = "appointment-card";
        addText(card, "summary", appointmentLabel(appointment));

        const form = document.createElement("form");
        form.className = "appointment-assignment-form";
        const selector = document.createElement("select");
        selector.setAttribute("aria-label", `Assignment for appointment ${appointment["Appointment ID"]}`);
        selector.disabled = true;
        form.appendChild(selector);
        const save = document.createElement("button");
        save.type = "submit";
        save.textContent = "Save assignment";
        save.disabled = true;
        form.appendChild(save);
        card.appendChild(form);

        let loading = false;
        card.addEventListener("toggle", async () => {
            if (!card.open || loading) return;
            loading = true;
            selector.disabled = true;
            save.disabled = true;
            selector.replaceChildren();
            const prompt = document.createElement("option");
            prompt.value = "";
            prompt.textContent = "Loading available staff…";
            selector.appendChild(prompt);
            try {
                const availableStaff = await request(
                    `/api/staff/appointments/${encodeURIComponent(appointment["Appointment ID"])}/available-staff`
                );
                selector.replaceChildren();
                const currentStaffId = String(appointment["Staff ID"] || "");
                const currentStaff = staffRecords.find(person => person.staffId === currentStaffId);
                const currentOption = document.createElement("option");
                currentOption.value = "keep";
                currentOption.textContent = currentStaffId
                    ? `Leave As-Is (${currentStaff?.name || "current staff member"})`
                    : "Leave Unassigned - Ticket will require scheduling";
                selector.appendChild(currentOption);

                if (currentStaffId) {
                    const unassignOption = document.createElement("option");
                    unassignOption.value = "unassign";
                    unassignOption.textContent = "Leave unassigned - Ticket will require scheduling";
                    selector.appendChild(unassignOption);
                }

                const otherAvailableStaff = availableStaff.filter(person =>
                    person.staffId !== currentStaffId
                );
                otherAvailableStaff.forEach(person => {
                    const option = document.createElement("option");
                    option.value = person.staffId;
                    option.textContent = `Assign to ${person.name} (${person.role})`;
                    selector.appendChild(option);
                });
                if (!otherAvailableStaff.length) {
                    const unavailableOption = document.createElement("option");
                    unavailableOption.value = "";
                    unavailableOption.textContent = "No other eligible staff available";
                    unavailableOption.disabled = true;
                    selector.appendChild(unavailableOption);
                }
                selector.value = "keep";
                selector.disabled = false;
                save.disabled = false;
            } catch (error) {
                selector.replaceChildren();
                const errorOption = document.createElement("option");
                errorOption.value = "";
                errorOption.textContent = "Unable to load available staff. Close and reopen to retry.";
                selector.appendChild(errorOption);
                status.textContent = error.message;
                status.setAttribute("role", "alert");
            } finally {
                loading = false;
            }
        });

        selector.addEventListener("change", () => {
            save.disabled = !selector.value;
        });
        form.addEventListener("submit", async event => {
            event.preventDefault();
            const choice = selector.value;
            if (!choice || choice === "keep") {
                card.open = false;
                return;
            }
            save.disabled = true;
            try {
                await request(`/api/staff/appointments/${encodeURIComponent(appointment["Appointment ID"])}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ staffId: choice === "unassign" ? "" : choice })
                });
                await loadDirectory();
                status.textContent = choice === "unassign"
                    ? "Appointment left unassigned and marked for scheduling."
                    : "Appointment assignment updated.";
            } catch (error) {
                status.textContent = error.message;
                status.setAttribute("role", "alert");
                save.disabled = false;
            }
        });
        return card;
    }

    function makeActionButton(label, onClick, disabled = false) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.disabled = disabled;
        button.addEventListener("click", onClick);
        return button;
    }

    function addTicketAssignmentControls(section, person) {
        const form = document.createElement("form");
        form.className = "staff-add-form";
        const ticketSelect = document.createElement("select");
        ticketSelect.required = true;
        ticketSelect.setAttribute("aria-label", `Unassigned ticket for ${person.name}`);
        const ticketPrompt = document.createElement("option");
        ticketPrompt.value = "";
        ticketPrompt.textContent = unassignedTickets.length
            ? "Choose an unassigned ticket"
            : "No unassigned tickets available";
        ticketPrompt.disabled = true;
        ticketPrompt.selected = true;
        ticketSelect.appendChild(ticketPrompt);
        unassignedTickets.forEach(ticket => {
            const option = document.createElement("option");
            option.value = ticket.ticketId;
            option.textContent = `${ticket.ticketId} · ${ticket.issue || "Issue"} · ${ticket.status || ""}`;
            ticketSelect.appendChild(option);
        });
        form.appendChild(ticketSelect);
        const submit = document.createElement("button");
        submit.type = "submit";
        submit.textContent = "Assign ticket";
        submit.disabled = unassignedTickets.length === 0 || !person.active;
        form.appendChild(submit);
        section.appendChild(form);
        const addButton = makeActionButton("+ Add ticket assignment", () => {
            form.classList.toggle("is-open");
        }, !person.active);
        if (!person.active) addButton.title = "Reactivate this staff member before assigning tickets.";
        section.appendChild(addButton);
        form.addEventListener("submit", async event => {
            event.preventDefault();
            submit.disabled = true;
            try {
                await request(`/api/staff/tickets/${encodeURIComponent(ticketSelect.value)}/assignment`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ staffId: person.staffId })
                });
                await loadDirectory();
                status.textContent = "Ticket assigned to staff member.";
            } catch (error) {
                status.textContent = error.message;
                status.setAttribute("role", "alert");
                submit.disabled = unassignedTickets.length === 0 || !person.active;
            }
        });
    }

    function addAppointmentControls(section, person) {
        const eligible = person.active &&
            ["technician", "engineer", "it support staff"].includes(String(person.role).trim().toLowerCase());
        const form = document.createElement("form");
        form.className = "staff-add-form";
        const ticketSelect = document.createElement("select");
        ticketSelect.required = true;
        ticketSelect.setAttribute("aria-label", `Assigned ticket for appointment with ${person.name}`);
        const ticketPrompt = document.createElement("option");
        ticketPrompt.value = "";
        ticketPrompt.textContent = person.tickets.length
            ? "Choose one of this staff member’s tickets"
            : "No tickets assigned";
        ticketPrompt.disabled = true;
        ticketPrompt.selected = true;
        ticketSelect.appendChild(ticketPrompt);
        person.tickets.forEach(ticket => {
            const option = document.createElement("option");
            option.value = ticket["Ticket ID"] || "";
            option.textContent = `${ticket["Ticket ID"] || "Ticket"} · ${ticket.Issue || "Issue"}`;
            ticketSelect.appendChild(option);
        });
        form.appendChild(ticketSelect);

        const address = document.createElement("input");
        address.type = "text";
        address.maxLength = 500;
        address.required = true;
        address.placeholder = "Visit address";
        address.setAttribute("aria-label", "Visit address");
        form.appendChild(address);

        const date = document.createElement("input");
        date.type = "date";
        date.required = true;
        date.setAttribute("aria-label", "Appointment date");
        form.appendChild(date);

        const kind = document.createElement("select");
        kind.setAttribute("aria-label", "Appointment type");
        [["visit", "Single visit"], ["project", "Project reservation"]].forEach(([value, label]) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            kind.appendChild(option);
        });
        form.appendChild(kind);

        const time = document.createElement("input");
        time.type = "time";
        time.required = true;
        time.setAttribute("aria-label", "Appointment start time");
        form.appendChild(time);

        const duration = document.createElement("input");
        duration.type = "number";
        duration.min = "0.5";
        duration.step = "0.5";
        duration.required = true;
        duration.placeholder = "Duration in hours";
        duration.setAttribute("aria-label", "Appointment duration in hours");
        form.appendChild(duration);

        const projectDays = document.createElement("input");
        projectDays.type = "number";
        projectDays.min = "1";
        projectDays.step = "1";
        projectDays.required = true;
        projectDays.placeholder = "Project reservation days";
        projectDays.setAttribute("aria-label", "Project reservation days");
        projectDays.hidden = true;
        form.appendChild(projectDays);

        const projectDayMode = document.createElement("select");
        projectDayMode.setAttribute("aria-label", "Project reservation day mode");
        [["calendar", "Calendar days"], ["weekdays", "Weekdays only"]].forEach(([value, label]) => {
            const option = document.createElement("option");
            option.value = value;
            option.textContent = label;
            projectDayMode.appendChild(option);
        });
        projectDayMode.hidden = true;
        form.appendChild(projectDayMode);

        kind.addEventListener("change", () => {
            const isProject = kind.value === "project";
            time.hidden = isProject;
            time.required = !isProject;
            duration.hidden = isProject;
            duration.required = !isProject;
            projectDays.hidden = !isProject;
            projectDays.required = isProject;
            projectDayMode.hidden = !isProject;
        });

        const submit = document.createElement("button");
        submit.type = "submit";
        submit.textContent = "Create appointment";
        submit.disabled = !person.tickets.length || !eligible;
        form.appendChild(submit);
        section.appendChild(form);
        const addButton = makeActionButton("+ Add appointment", () => {
            form.classList.toggle("is-open");
        }, !eligible);
        if (!eligible) {
            addButton.title = "Only active technicians, engineers, and IT support staff can be scheduled.";
        }
        section.appendChild(addButton);
        form.addEventListener("submit", async event => {
            event.preventDefault();
            submit.disabled = true;
            const isProject = kind.value === "project";
            const payload = {
                staffId: person.staffId,
                address: address.value.trim(),
                date: date.value,
                time: isProject ? "" : time.value,
                durationHours: isProject ? 0 : Number(duration.value),
                projectDays: isProject ? Number(projectDays.value) : 0,
                projectDayMode: isProject ? projectDayMode.value : ""
            };
            try {
                await request(`/api/staff/tickets/${encodeURIComponent(ticketSelect.value)}/appointments`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload)
                });
                await loadDirectory();
                status.textContent = "Appointment created for staff member.";
            } catch (error) {
                status.textContent = error.message;
                status.setAttribute("role", "alert");
                submit.disabled = !person.tickets.length || !eligible;
            }
        });
    }

    function renderAppointments(items) {
        unassignedAppointments.replaceChildren();
        if (!items.length) {
            addText(unassignedAppointments, "p", "No visits currently require scheduling.");
            return;
        }
        items.forEach(appointment => {
            const row = document.createElement("div");
            row.className = "staff-entry unassigned-appointment";
            row.appendChild(createAppointmentAssignmentCard(appointment));
            const isProject = Number(appointment["Project Days"] || 0) > 0;
            const scheduleForm = document.createElement("form");
            scheduleForm.className = "staff-actions";
            const dateInput = document.createElement("input");
            dateInput.type = "date";
            dateInput.value = appointment["Start Date"] || "";
            dateInput.setAttribute("aria-label", "Appointment date");
            scheduleForm.appendChild(dateInput);
            if (isProject) {
                const daysInput = document.createElement("input");
                daysInput.type = "number";
                daysInput.min = "1";
                daysInput.step = "1";
                daysInput.value = appointment["Project Days"];
                daysInput.setAttribute("aria-label", "Project reservation days");
                scheduleForm.appendChild(daysInput);
                const modeSelect = document.createElement("select");
                modeSelect.setAttribute("aria-label", "Project reservation day mode");
                [["calendar", "Calendar days"], ["weekdays", "Weekdays only"]].forEach(([value, label]) => {
                    const option = document.createElement("option");
                    option.value = value;
                    option.textContent = label;
                    modeSelect.appendChild(option);
                });
                modeSelect.value = appointment["Project Day Mode"] || "calendar";
                scheduleForm.appendChild(modeSelect);
                scheduleForm.addEventListener("submit", async event => {
                    event.preventDefault();
                    try {
                        await request(`/api/staff/appointments/${encodeURIComponent(appointment["Appointment ID"])}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                date: dateInput.value,
                                projectDays: Number(daysInput.value),
                                projectDayMode: modeSelect.value
                            })
                        });
                        await loadDirectory();
                    } catch (error) {
                        status.textContent = error.message;
                        status.setAttribute("role", "alert");
                    }
                });
            } else {
                const timeInput = document.createElement("input");
                timeInput.type = "time";
                timeInput.value = appointment["Start Time"] || "";
                timeInput.setAttribute("aria-label", "Appointment start time");
                scheduleForm.appendChild(timeInput);
                const durationInput = document.createElement("input");
                durationInput.type = "number";
                durationInput.min = "0.5";
                durationInput.step = "0.5";
                durationInput.value = String(
                    (new Date(`${appointment["End Date"]}T${appointment["End Time"]}`) -
                        new Date(`${appointment["Start Date"]}T${appointment["Start Time"]}`)) / 3600000
                );
                durationInput.setAttribute("aria-label", "Appointment duration in hours");
                scheduleForm.appendChild(durationInput);
                scheduleForm.addEventListener("submit", async event => {
                    event.preventDefault();
                    try {
                        await request(`/api/staff/appointments/${encodeURIComponent(appointment["Appointment ID"])}`, {
                            method: "PATCH",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                date: dateInput.value,
                                time: timeInput.value,
                                durationHours: Number(durationInput.value)
                            })
                        });
                        await loadDirectory();
                    } catch (error) {
                        status.textContent = error.message;
                        status.setAttribute("role", "alert");
                    }
                });
            }
            const reschedule = document.createElement("button");
            reschedule.type = "submit";
            reschedule.textContent = "Save new time";
            scheduleForm.appendChild(reschedule);
            row.appendChild(scheduleForm);
            unassignedAppointments.appendChild(row);
        });
    }

    function renderStaff() {
        directory.replaceChildren();
        if (!staffRecords.length) {
            addText(directory, "p", "No staff records found.");
            return;
        }
        staffRecords.forEach(person => {
            const details = document.createElement("details");
            details.className = `staff-entry${person.active ? "" : " inactive"}`;
            const summary = document.createElement("summary");
            const nameElement = document.createElement("strong"); nameElement.className = "staff-entry-name"; nameElement.textContent = person.name || "Unnamed staff member";
            const roleElement = document.createElement("span"); roleElement.className = "staff-entry-role"; roleElement.textContent = `${person.role}${person.department ? ` - ${person.department}` : ""}`;
            const statusElement = document.createElement("span"); statusElement.className = "staff-entry-status"; statusElement.textContent = person.active ? "Active" : "Inactive";
            summary.append(nameElement, roleElement, statusElement); details.appendChild(summary);

            const grid = document.createElement("div");
            grid.className = "staff-detail-grid";
            const contact = document.createElement("section");
            addText(contact, "h3", "Staff details");
            addText(contact, "p", `Email: ${person.email || "Not provided"}`);
            addText(contact, "p", `Phone: ${person.phone || "Not provided"}`);
            if (person.loginStaffId) addText(contact, "p", "Linked to a login account");
            const form = document.createElement("form");
            form.className = "staff-edit-form";
            const inputs = [
                ["name", "Name", person.name, 120],
                ["role", "Role", person.role, 80],
                ["department", "Department", person.department, 120],
                ["email", "Email", person.email, 254],
                ["phone", "Phone", person.phone, 40]
            ];
            const formGrid = document.createElement("div");
            formGrid.className = "staff-form-grid";
            inputs.forEach(([name, label, value, maxLength]) => {
                const field = document.createElement("label");
                field.textContent = label;
                const input = document.createElement("input");
                input.name = name;
                input.value = value || "";
                input.maxLength = maxLength;
                if (name === "name" || name === "role") input.required = true;
                if (name === "email") input.type = "email";
                field.appendChild(input);
                formGrid.appendChild(field);
            });
            const loginField = document.createElement("label");
            loginField.textContent = "Linked login account";
            const loginSelect = document.createElement("select");
            loginSelect.name = "loginStaffId";
            const noLogin = document.createElement("option");
            noLogin.value = "";
            noLogin.textContent = "No linked account";
            loginSelect.appendChild(noLogin);
            loginAccounts.filter(account =>
                !account.staffId ||
                account.staffId === person.loginStaffId ||
                !staffRecords.some(other =>
                    other.staffId !== person.staffId && other.loginStaffId === account.staffId
                )
            ).forEach(account => {
                const option = document.createElement("option");
                option.value = account.staffId;
                option.textContent = `${account.name} (${account.email})`;
                loginSelect.appendChild(option);
            });
            loginSelect.value = person.loginStaffId || "";
            loginField.appendChild(loginSelect);
            formGrid.appendChild(loginField);
            form.appendChild(formGrid);
            const actions = document.createElement("div");
            actions.className = "staff-actions";
            const save = document.createElement("button");
            save.type = "submit";
            save.textContent = "Save Changes";
            actions.appendChild(save);
            const deactivate = document.createElement("button");
            deactivate.type = "button";
            deactivate.className = "secondary";
            deactivate.textContent = person.active ? "Deactivate" : "Reactivate";
            deactivate.addEventListener("click", async () => {
                deactivate.disabled = true;
                try {
                    await request(`/api/staff/directory/${encodeURIComponent(person.staffId)}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ active: !person.active })
                    });
                    await loadDirectory();
                } catch (error) {
                    status.textContent = error.message;
                    status.setAttribute("role", "alert");
                    deactivate.disabled = false;
                }
            });
            actions.appendChild(deactivate);
            form.appendChild(actions);
            form.addEventListener("submit", async event => {
                event.preventDefault();
                const payload = Object.fromEntries(new FormData(form));
                save.disabled = true;
                try {
                    await request(`/api/staff/directory/${encodeURIComponent(person.staffId)}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(payload)
                    });
                    await loadDirectory();
                    status.textContent = "Staff record updated.";
                } catch (error) {
                    status.textContent = error.message;
                    status.setAttribute("role", "alert");
                } finally {
                    save.disabled = false;
                }
            });
            contact.appendChild(form);
            grid.appendChild(contact);

            const ticketsSection = document.createElement("section");
            addText(ticketsSection, "h3", `Ticket assignments (${person.tickets.length})`);
            const ticketList = document.createElement("ul");
            person.tickets.forEach(ticket => {
                addText(ticketList, "li", `${ticket["Ticket ID"] || ""} · ${ticket.Issue || "Issue"} · ${ticket.Status || ""}`);
            });
            if (!person.tickets.length) addText(ticketList, "li", "No tickets assigned.");
            ticketsSection.appendChild(ticketList);
            addTicketAssignmentControls(ticketsSection, person);
            grid.appendChild(ticketsSection);

            const visitsSection = document.createElement("section");
            visitsSection.className = "person-appointments";

            addText(
                visitsSection,
                "h3",
                `Appointments (${person.appointments.length})`
            );

            const visitList = document.createElement("div");
            visitList.className = "appointment-list";

            person.appointments.forEach(appointment => {
                visitList.appendChild(
                    createAppointmentAssignmentCard(appointment)
                );
            });

            if (!person.appointments.length) {
                addText(visitList, "p", "No appointments assigned.");
            }

            visitsSection.appendChild(visitList);
            addAppointmentControls(visitsSection, person);

            grid.appendChild(visitsSection);
            details.appendChild(grid);
            directory.appendChild(details);
        });
    }

    async function loadDirectory() {
        status.textContent = "Loading staff and appointments...";
        status.setAttribute("role", "status");
        try {
            const [directoryData, appointmentData] = await Promise.all([
                request("/api/staff/directory"),
                request("/api/staff/appointments")
            ]);
            staffRecords = directoryData.staff || [];
            loginAccounts = directoryData.loginAccounts || [];
            unassignedTickets = directoryData.unassignedTickets || [];
            appointments = appointmentData || [];
            const newLoginSelect = document.getElementById("newLoginStaffId");
            if (newLoginSelect) {
                newLoginSelect.replaceChildren();
                const noLogin = document.createElement("option");
                noLogin.value = "";
                noLogin.textContent = "No linked account";
                newLoginSelect.appendChild(noLogin);
                loginAccounts.filter(account =>
                    !staffRecords.some(person => person.loginStaffId === account.staffId)
                ).forEach(account => {
                    const option = document.createElement("option");
                    option.value = account.staffId;
                    option.textContent = `${account.name} (${account.email})`;
                    newLoginSelect.appendChild(option);
                });
            }
            renderStaff();
            renderAppointments(appointments.filter(appointment =>
                !appointment["Staff ID"] &&
                ["Pending", "Reschedule Required"].includes(appointment.Status)
            ));
            status.textContent = `${staffRecords.length} staff records`;
        } catch (error) {
            status.textContent = error.message;
            status.setAttribute("role", "alert");
        }
    }

    document.getElementById("addStaffButton").addEventListener("click", () => {
        createFormSection.style.display = "block";
        createForm.elements.name.focus();
    });
    document.getElementById("cancelAddStaff").addEventListener("click", () => {
        createForm.reset();
        createFormSection.style.display = "none";
    });
    createForm.addEventListener("submit", async event => {
        event.preventDefault();
        const submit = createForm.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
            await request("/api/staff/directory", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(Object.fromEntries(new FormData(createForm)))
            });
            createForm.reset();
            createFormSection.style.display = "none";
            await loadDirectory();
            status.textContent = "Staff record created.";
        } catch (error) {
            status.textContent = error.message;
            status.setAttribute("role", "alert");
        } finally {
            submit.disabled = false;
        }
    });

    loadDirectory();
})();

(function () {
    const tableBody = document.getElementById("customerTableBody");
    const searchInput = document.getElementById("customerSearch");
    const directoryStatus = document.getElementById("customerDatabaseStatus");
    const detailStatus = document.getElementById("customerDetailStatus");

    function redirectToStaffLogin() {
        localStorage.removeItem("staff");
        window.location.href = "/staff-login.html";
    }

    async function fetchStaffData(url) {
        const response = await fetch(url);
        const data = await response.json();

        if (response.status === 401) {
            redirectToStaffLogin();
            return null;
        }
        if (!response.ok) {
            throw new Error(data.message || "Unable to load customer data.");
        }
        return data;
    }

    function formatCredits(credits) {
        return `${credits} ${Number(credits) === 1 ? "credit" : "credits"}`;
    }

    function setStatus(element, message, isError) {
        element.textContent = message;
        element.hidden = !message;
        if (isError) {
            element.setAttribute("role", "alert");
        } else {
            element.setAttribute("role", "status");
        }
    }

    function renderCustomerRows(customers) {
        if (!tableBody) {
            return;
        }

        const query = searchInput.value.trim().toLowerCase();
        const visibleCustomers = customers.filter(customer =>
            [customer.id, customer.name, customer.email]
                .some(value => String(value || "").toLowerCase().includes(query))
        );
        tableBody.replaceChildren();

        visibleCustomers.forEach(customer => {
            const row = document.createElement("tr");
            row.className = "customer-row";
            const customerUrl = customer.id
                ? `/customer-details.html?customerId=${encodeURIComponent(customer.id)}`
                : "";

            const idCell = document.createElement("td");
            idCell.className = "customer-id-cell";
            idCell.textContent = customer.id || "";
            row.append(idCell);

            const nameCell = document.createElement("td");
            if (customerUrl) {
                const customerLink = document.createElement("a");
                customerLink.className = "customer-link";
                customerLink.href = customerUrl;
                customerLink.textContent = customer.name || customer.id;
                nameCell.append(customerLink);
            } else {
                nameCell.textContent = customer.name || "";
            }
            row.append(nameCell);

            row.addEventListener("click", event => {
                if (!customerUrl || event.target.closest("a, button")) {
                    return;
                }

                window.location.href = customerUrl;
            });

            [customer.email, formatCredits(customer.credits), customer.totalTickets]
                .forEach(value => {
                    const cell = document.createElement("td");
                    cell.textContent = String(value ?? "");
                    row.append(cell);
                });
            tableBody.append(row);
        });

        if (visibleCustomers.length === 0) {
            setStatus(
                directoryStatus,
                customers.length === 0
                    ? "No customers are in the database yet."
                    : "No customers match your search.",
                false
            );
        } else {
            setStatus(directoryStatus, "", false);
        }
    }

    async function loadCustomerDirectory() {
        try {
            const customers = await fetchStaffData("/api/staff/customers");
            if (!customers) {
                return;
            }
            renderCustomerRows(customers);
            searchInput.addEventListener("input", () => renderCustomerRows(customers));
        } catch (error) {
            console.error("Customer directory error:", error);
            setStatus(directoryStatus, error.message, true);
        }
    }

    function renderTicketList(containerId, tickets) {
        const container = document.getElementById(containerId);
        container.replaceChildren();

        if (tickets.length === 0) {
            const emptyMessage = document.createElement("p");
            emptyMessage.className = "ticket-empty";
            emptyMessage.textContent = "No tickets in this category.";
            container.append(emptyMessage);
            return;
        }

        tickets.forEach(ticket => {
            const item = document.createElement("article");
            item.className = "customer-ticket";

            const link = document.createElement("a");
            link.className = "ticket-id";
            link.href = `/ticket-details.html?ticketId=${encodeURIComponent(ticket.ticketId)}`;
            link.textContent = ticket.ticketId || "Ticket";

            const issue = document.createElement("span");
            issue.textContent = ticket.issue || "No issue description";

            const detail = document.createElement("span");
            detail.className = "ticket-secondary";
            const createdTimestamp = Date.parse(ticket.createdDate || "");
            const submittedDate = Number.isFinite(createdTimestamp)
                ? new Date(createdTimestamp).toLocaleDateString()
                : "";
            detail.textContent = [
                ticket.supportType,
                ticket.status,
                ticket.assignedEngineer ? `Assigned: ${ticket.assignedEngineer}` : "",
                submittedDate ? `Submitted: ${submittedDate}` : ""
            ]
                .filter(Boolean)
                .join(" · ");

            item.append(link, issue, detail);
            if (containerId === "pendingPaymentTicketList") {
                const unpaid = document.createElement("strong");
                unpaid.textContent = `${ticket.unpaidCredits} unpaid credits`;
                item.append(unpaid);
            }
            container.append(item);
        });
    }

    function renderCustomerDetails(data) {
        const { customer, ticketCounts, tickets } = data;
        document.title = `${customer.name || customer.id} - IT Support`;
        document.getElementById("customerName").textContent = customer.name || "Customer Details";
        document.getElementById("customerId").textContent = customer.id || "—";
        document.getElementById("customerEmail").textContent = customer.email || "—";
        document.getElementById("customerCredits").textContent = formatCredits(customer.credits);
        document.getElementById("totalTickets").textContent = ticketCounts.total;
        document.getElementById("openTicketCount").textContent = ticketCounts.open;
        document.getElementById("inProgressTicketCount").textContent = ticketCounts.inProgress;
        document.getElementById("pendingPaymentTicketCount").textContent = ticketCounts.pendingPayment;
        document.getElementById("closedTicketCount").textContent = ticketCounts.closed;

        renderTicketList("openTicketList", tickets.open);
        renderTicketList("inProgressTicketList", tickets.inProgress);
        renderTicketList("pendingPaymentTicketList", tickets.pendingPayment);
        renderTicketList("closedTicketList", tickets.closed);
        setStatus(detailStatus, "", false);
    }

    async function loadCustomerDetails() {
        const customerId = new URLSearchParams(window.location.search).get("customerId");
        if (!customerId) {
            setStatus(detailStatus, "A customer ID was not provided.", true);
            return;
        }

        try {
            const data = await fetchStaffData(
                `/api/staff/customers/${encodeURIComponent(customerId)}`
            );
            if (data) {
                renderCustomerDetails(data);
            }
        } catch (error) {
            console.error("Customer details error:", error);
            setStatus(detailStatus, error.message, true);
        }
    }

    if (tableBody && searchInput && directoryStatus) {
        loadCustomerDirectory();
    }
    if (detailStatus) {
        loadCustomerDetails();
    }
})();

function countTicketStatuses(tickets) {
    const counts = {
        total: tickets.length,
        open: 0,
        inProgress: 0,
        closed: 0
    };

    for (const ticket of tickets) {
        switch (ticket.Status) {
            case "Open":
                counts.open += 1;
                break;
            case "In Progress":
            case "Pending":
                counts.inProgress += 1;
                break;
            case "Closed":
                counts.closed += 1;
                break;
        }
    }

    return counts;
}

function filterTicketsByStatus(tickets, filter) {
    return tickets.filter(ticket => {
        switch (filter) {
            case "open":
                return ticket.Status === "Open";
            case "inProgressPending":
                return ticket.Status === "In Progress" || ticket.Status === "Pending";
            case "closed":
                return ticket.Status === "Closed";
            default:
                return true;
        }
    });
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = countTicketStatuses;
    module.exports.filterTicketsByStatus = filterTicketsByStatus;
}
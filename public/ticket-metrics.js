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
                counts.inProgress += 1;
                break;
            case "Closed":
                counts.closed += 1;
                break;
        }
    }

    return counts;
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = countTicketStatuses;
}
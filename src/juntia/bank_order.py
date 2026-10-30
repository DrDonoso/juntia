from graphlib import CycleError, TopologicalSorter

from sqlalchemy import delete, insert, select
from sqlalchemy.engine import Connection

from .db import ImportRow, Transaction, TransactionOrder
from .errors import AppError


def rebuild_bank_order(connection: Connection) -> None:
    collation = "C" if connection.dialect.name == "postgresql" else "BINARY"
    rows = connection.execute(
        select(Transaction.id, Transaction.booking_date, Transaction.identity_key)
        .order_by(Transaction.identity_key.collate(collation))
    ).all()
    dates = {row.id: row.booking_date for row in rows}
    predecessors: dict[int, set[int]] = {row.id: set() for row in rows}
    previous = None
    for source in connection.execute(
        select(ImportRow.import_id, ImportRow.ordinal, ImportRow.transaction_id)
        .order_by(ImportRow.import_id.collate(collation), ImportRow.ordinal)
    ):
        if previous is not None and previous.import_id == source.import_id:
            newer, older = previous.transaction_id, source.transaction_id
            if dates[newer] == dates[older]:
                predecessors[older].add(newer)
        previous = source
    try:
        ordered = sorted(
            TopologicalSorter(predecessors).static_order(),
            key=lambda key: dates[key], reverse=True,
        )
    except CycleError:
        raise AppError("conflicting_order", 409) from None
    connection.execute(delete(TransactionOrder))
    for offset in range(0, len(ordered), 500):
        connection.execute(insert(TransactionOrder), [
            {"transaction_id": key, "position": position, "is_root": not predecessors[key]}
            for position, key in enumerate(ordered[offset:offset + 500], start=offset)
        ])

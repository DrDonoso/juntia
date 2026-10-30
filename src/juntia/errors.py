class AppError(Exception):
    def __init__(
        self, code: str, status: int = 422, *, fields: dict[str, str] | None = None,
    ):
        super().__init__(code)
        self.code = code
        self.status = status
        self.fields = fields

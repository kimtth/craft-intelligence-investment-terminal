"""P1 synthetic daily-data schemas; no execution or accounting engine."""

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from fractions import Fraction
from typing import Annotated, Literal, Self

from pydantic import (
    AwareDatetime,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StringConstraints,
    model_validator,
)


def _decimal(value: object) -> Decimal:
    if isinstance(value, Decimal):
        result = value
    elif isinstance(value, str) and re.fullmatch(
        r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?", value
    ):
        try:
            result = Decimal(value)
        except InvalidOperation as exc:
            raise ValueError("expected a finite Decimal string") from exc
    else:
        raise ValueError("expected a Decimal or decimal string, never a JSON number")
    if not result.is_finite():
        raise ValueError("expected a finite Decimal string")
    return result


def _timestamp(value: object) -> object:
    if not isinstance(value, (str, datetime)):
        raise ValueError("timestamp must be an aware ISO 8601 string or datetime")
    if isinstance(value, str) and (value != value.strip() or "T" not in value):
        raise ValueError("timestamp must be an aware ISO 8601 string")
    return value


def _date(value: object) -> object:
    if type(value) is date:
        return value
    if isinstance(value, str) and re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", value):
        return value
    raise ValueError("date must be YYYY-MM-DD or a date object")


Text = Annotated[str, StringConstraints(strict=True, min_length=1, pattern=r"\S")]
DecimalValue = Annotated[Decimal, BeforeValidator(_decimal)]
PositiveDecimal = Annotated[DecimalValue, Field(gt=0)]
NonnegativeDecimal = Annotated[DecimalValue, Field(ge=0)]
Rate = Annotated[DecimalValue, Field(ge=0, lt=1)]
Timestamp = Annotated[AwareDatetime, BeforeValidator(_timestamp)]
CalendarDate = Annotated[date, BeforeValidator(_date)]
PositiveInt = Annotated[int, Field(strict=True, ge=1)]
NonnegativeInt = Annotated[int, Field(strict=True, ge=0)]


class ContractModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, revalidate_instances="always")


class Evidence(ContractModel):
    """Named references are required even for synthetic empty-action evidence."""

    price_versions: Text
    universe: Text
    corporate_actions: Text
    delist_settlement: Text


class DatasetManifest(ContractModel):
    schema_version: Literal["0.1"]
    dataset_id: Text
    kind: Literal["synthetic", "real_archive"]
    provider: Text
    market: Text
    currency: Literal["USD"]
    calendar_id: Text
    collected_at: Timestamp
    raw_snapshot_id: Text
    normalized_snapshot_id: Text
    rights: Text
    universe_id: Text
    coverage_start: CalendarDate
    coverage_end: CalendarDate
    evidence: Evidence

    @model_validator(mode="after")
    def ordered_coverage(self) -> Self:
        if self.coverage_start > self.coverage_end:
            raise ValueError("coverage_start must not follow coverage_end")
        return self


class Session(ContractModel):
    session_date: CalendarDate
    open_at: Timestamp
    close_at: Timestamp

    @model_validator(mode="after")
    def ordered_times(self) -> Self:
        if self.open_at >= self.close_at:
            raise ValueError("session open_at must precede close_at")
        if self.open_at.date() != self.session_date or self.close_at.date() != self.session_date:
            raise ValueError("session timestamps must match session_date in their stated timezone")
        return self


class Observation(ContractModel):
    asset_id: Text
    field: Literal["open", "close"]
    observed_at: Timestamp
    available_at: Timestamp
    revision: PositiveInt
    value: PositiveDecimal
    adjustment: Literal["raw"]

    @model_validator(mode="after")
    def publication_order(self) -> Self:
        if self.available_at < self.observed_at:
            raise ValueError("observation cannot be available before observed_at")
        return self


class UniverseEvent(ContractModel):
    asset_id: Text
    effective_at: Timestamp
    available_at: Timestamp
    action: Literal["enter", "exit"]
    source: Text


class CorporateAction(ContractModel):
    action_id: Text
    asset_id: Text
    kind: Literal["split", "dividend", "delist"]
    effective_at: Timestamp
    available_at: Timestamp
    source: Text
    ratio: PositiveDecimal | None = None
    cash_per_share: NonnegativeDecimal | None = None
    pay_at: Timestamp | None = None

    @model_validator(mode="after")
    def compatible_fields(self) -> Self:
        if self.kind == "split":
            if self.ratio is None or self.cash_per_share is not None or self.pay_at is not None:
                raise ValueError("split requires ratio only, not cash_per_share or pay_at")
        else:
            if self.ratio is not None or self.cash_per_share is None or self.pay_at is None:
                raise ValueError("dividend/delist requires explicit cash_per_share and pay_at only")
            if self.pay_at < self.effective_at:
                raise ValueError("pay_at must not precede effective_at")
        return self


class Dataset(ContractModel):
    manifest: DatasetManifest
    sessions: tuple[Session, ...] = Field(min_length=1)
    observations: tuple[Observation, ...] = Field(min_length=1)
    universe_events: tuple[UniverseEvent, ...] = Field(min_length=1)
    corporate_actions: tuple[CorporateAction, ...]


class ResearchSpec(ContractModel):
    schema_version: Literal["0.1"]
    dataset_id: Text
    universe_id: Text
    start: CalendarDate
    end: CalendarDate
    initial_cash: PositiveDecimal
    allocation: Literal["equal", "fixed"]
    weights: dict[Text, NonnegativeDecimal]
    rebalance_every: PositiveInt
    lookback: NonnegativeInt
    fee_rate: Rate
    slippage_rate: Rate
    quantity_step: PositiveDecimal
    benchmark: Literal["equal_weight_buy_and_hold"]
    execution: Literal["next_open"]
    valuation: Literal["raw_close"]

    @model_validator(mode="after")
    def supported_spec(self) -> Self:
        if self.start > self.end:
            raise ValueError("start must not follow end")
        if self.quantity_step != Decimal("1"):
            raise ValueError("P1 supports quantity_step 1 only")
        if self.allocation == "equal" and self.weights:
            raise ValueError("equal allocation must not contain weights")
        if self.allocation == "fixed":
            if not self.weights:
                raise ValueError("fixed allocation requires explicit weights")
            # Exact integer ratios avoid context rounding hiding a sum slightly above 1.
            if sum((Fraction(weight) for weight in self.weights.values()), Fraction(0)) > 1:
                raise ValueError("fixed weights must sum to at most 1")
        return self
"""Pydantic v2 wire schemas (contract sections 2.2, 3, 6.1, 7, 8)."""

from app.schemas.auth import DeviceAuthRequest, DeviceAuthResponse, FarmerOut, Locale
from app.schemas.batch import BatchCreate, BatchOut, BatchPatch
from app.schemas.common import ApiModel, UtcDatetime, UuidStr, is_uuid, iso_z, parse_iso_z, to_utc
from app.schemas.demo import DemoSeedResponse
from app.schemas.health import HealthResponse
from app.schemas.mandi import MandiOut
from app.schemas.price import MandiPriceOut, PriceMeta, PriceRefreshResponse, PricesResponse
from app.schemas.protocol import HardThreshold, ProtocolOut, ThresholdType
from app.schemas.quality_pass import PassReading, QualityPassPayload, QualityPassVerify
from app.schemas.reading import ReadingCreate, ReadingOut
from app.schemas.recommendation import MandiCandidate, Recommendation, RoutingConstants
from app.schemas.shelf_life import Breach, ScenarioEnd, ScenarioHours, Segment, ShelfLifeEstimate
from app.schemas.sync import SyncOpIn, SyncRequest, SyncResponse, SyncResult

__all__ = [
    "ApiModel", "BatchCreate", "BatchOut", "BatchPatch", "Breach", "DemoSeedResponse",
    "DeviceAuthRequest", "DeviceAuthResponse", "FarmerOut", "HardThreshold", "HealthResponse",
    "Locale", "MandiCandidate", "MandiOut", "MandiPriceOut", "PassReading", "PriceMeta",
    "PriceRefreshResponse", "PricesResponse", "ProtocolOut", "QualityPassPayload",
    "QualityPassVerify", "ReadingCreate", "ReadingOut", "Recommendation", "RoutingConstants",
    "ScenarioEnd", "ScenarioHours", "Segment", "ShelfLifeEstimate", "SyncOpIn", "SyncRequest",
    "SyncResponse", "SyncResult", "ThresholdType", "UtcDatetime", "UuidStr", "is_uuid", "iso_z",
    "parse_iso_z", "to_utc",
]

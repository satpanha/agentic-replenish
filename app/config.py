"""Central configuration. Everything comes from environment variables (.env supported)."""
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent

LLM_BASE_URL = os.getenv("LLM_BASE_URL", "").strip()
LLM_API_KEY = os.getenv("LLM_API_KEY", "").strip()
LLM_MODEL = os.getenv("LLM_MODEL", "").strip()
LLM_ENABLED = bool(LLM_BASE_URL and LLM_API_KEY and LLM_MODEL)

APPROVER_KEY = os.getenv("APPROVER_KEY", "demo-approver")

DATA_DIR = Path(os.getenv("DATA_DIR", "app/data_sample"))
if not DATA_DIR.is_absolute():
    DATA_DIR = ROOT / DATA_DIR
DB_PATH = Path(os.getenv("DB_PATH", "var/replenish.db"))
if not DB_PATH.is_absolute():
    DB_PATH = ROOT / DB_PATH

SERVICE_LEVEL = float(os.getenv("SERVICE_LEVEL", "0.95"))
REVIEW_DAYS = int(os.getenv("REVIEW_DAYS", "7"))
EXCESS_COVER_DAYS = float(os.getenv("EXCESS_COVER_DAYS", "90"))
FORECAST_HORIZON = 56  # days; must cover max(lead time) + review period

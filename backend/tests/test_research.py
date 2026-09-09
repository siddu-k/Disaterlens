import pytest
from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_research_analyze_endpoint_structure():
    # Test request with mock lat/lng coordinates
    payload = {
        "lat": 17.385,
        "lng": 78.486,
        "bbox": [17.38, 78.48, 17.39, 78.49],
        "model": "gemini-3.5-flash-lite"
    }
    response = client.post("/api/research/analyze", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "location" in data
    assert "location_insight" in data
    assert "soil" in data
    assert "crops" in data
    assert isinstance(data["crops"], list)
    assert len(data["crops"]) > 0

def test_research_chat_endpoint():
    payload = {
        "question": "What crop is best suited for clay soil?",
        "context": "Location: Hyderabad. Soil: Clayey loam, pH 6.8",
        "model": "gemini-3.5-flash-lite"
    }
    response = client.post("/api/research/chat", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert "answer" in data
    assert len(data["answer"]) > 10

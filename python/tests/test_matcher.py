"""
test_matcher.py: matcher 모듈 단위 테스트

OpenAI API 호출이 필요한 테스트는 mock을 사용한다.
"""

import json
import pytest
from unittest.mock import MagicMock, patch
from matcher import _build_item_list, match_all, create_matching_plan, OPENAI_MODEL


class TestBuildItemList:
    def test_short_list(self):
        items = ["항목1", "항목2", "항목3"]
        result = _build_item_list(items)
        assert "1. 항목1" in result
        assert "2. 항목2" in result
        assert "3. 항목3" in result

    def test_long_list_truncated(self):
        items = [f"항목{i}" for i in range(100)]
        result = _build_item_list(items)
        assert "1. 항목0" in result
        assert "50. 항목49" in result
        assert "중간" in result
        assert "91. 항목90" in result

    def test_empty_items(self):
        items = ["", None, "유효한 항목"]
        result = _build_item_list(items)
        assert "(빈 항목)" in result
        assert "유효한 항목" in result

    def test_long_item_truncated(self):
        items = ["가" * 200]
        result = _build_item_list(items)
        assert len(result.split("\n")[0]) <= 110  # "1. " + 100자


class TestMatchAllWithMock:
    def _make_mock_client(self, response_data):
        """OpenAI 클라이언트 mock 생성."""
        mock_client = MagicMock()
        mock_response = MagicMock()
        mock_choice = MagicMock()
        mock_choice.message.content = json.dumps(response_data)
        mock_response.choices = [mock_choice]
        mock_response.usage = MagicMock(
            prompt_tokens=100, completion_tokens=50, total_tokens=150
        )
        mock_client.chat.completions.create.return_value = mock_response
        return mock_client

    def test_basic_matching(self):
        response = {
            "matches": [
                {"itemIndex": 1, "fileIndex": 1, "page": "p.1", "score": 90, "reason": "매칭"},
                {"itemIndex": 2, "fileIndex": None, "page": None, "score": 0, "reason": "없음"},
            ]
        }
        client = self._make_mock_client(response)

        items = ["항목1", "항목2"]
        file_indexes = [
            {"file_id": "f1", "file_name": "file1.docx", "pages": [
                {"page_label": "p.1", "summary": "내용", "has_match": True, "matched_item_indices": [0]},
            ]},
        ]

        matches = match_all(items, file_indexes, None, client)
        assert len(matches) == 2
        assert matches[0]["file_id"] == "f1"
        assert matches[0]["score"] == 90
        assert matches[1]["file_id"] is None

    def test_chunked_matching(self):
        # 35개 항목 → 2 청크 (20 + 15)
        response = {
            "matches": [
                {"itemIndex": i + 1, "fileIndex": 1, "page": "p.1", "score": 80, "reason": "ok"}
                for i in range(20)
            ]
        }
        client = self._make_mock_client(response)

        items = [f"항목{i}" for i in range(35)]
        file_indexes = [
            {"file_id": "f1", "file_name": "file1.docx", "pages": [
                {"page_label": "p.1", "summary": "내용" * 50, "has_match": True,
                 "matched_item_indices": list(range(35))},
            ]},
        ] * 25  # 25개 파일 → 청크 모드 진입

        matches = match_all(items, file_indexes, None, client)
        # 첫 청크 20개 + 두번째 청크 (15개지만 mock은 20개 반환)
        assert len(matches) > 0

    def test_matching_plan(self):
        response = {
            "domain": "솔루션상용화",
            "projectType": "웹앱",
            "lifecycle": "기획→설계→개발→테스트→배포",
            "namingConventions": ["[프로젝트명]_산출물유형_v버전"],
            "searchStrategy": "생명주기 단계별 문서 매칭",
        }
        client = self._make_mock_client(response)

        plan = create_matching_plan(["항목1", "항목2"], client)
        assert plan is not None
        assert plan["domain"] == "솔루션상용화"
        assert "lifecycle" in plan

"""
test_keyword_matcher.py: keyword_matcher 모듈 단위 테스트
"""

import pytest
from keyword_matcher import match_by_keyword, _calculate_coverage, _format_pages


class TestCalculateCoverage:
    def test_full_coverage(self):
        file_index = {
            "file_id": "1",
            "file_name": "test.docx",
            "pages": [
                {"summary": "운영자 매뉴얼 시스템 관리 설정 가이드 안내서", "page_label": "p.1"},
            ],
        }
        terms = ["운영자", "매뉴얼", "시스템", "관리", "설정"]
        result = _calculate_coverage(file_index, terms)
        assert result["ratio"] == 1.0
        assert result["matched"] == 5
        assert result["total"] == 5

    def test_partial_coverage(self):
        file_index = {
            "file_id": "1",
            "file_name": "test.docx",
            "pages": [
                {"summary": "운영자 매뉴얼 가이드", "page_label": "p.1"},
            ],
        }
        terms = ["운영자", "매뉴얼", "시스템", "관리", "설정"]
        result = _calculate_coverage(file_index, terms)
        assert result["ratio"] == 0.4  # 2/5
        assert result["matched"] == 2

    def test_no_coverage(self):
        file_index = {
            "file_id": "1",
            "file_name": "test.docx",
            "pages": [
                {"summary": "전혀 관련 없는 내용", "page_label": "p.1"},
            ],
        }
        terms = ["운영자", "매뉴얼"]
        result = _calculate_coverage(file_index, terms)
        assert result["ratio"] == 0.0

    def test_multi_page_coverage(self):
        file_index = {
            "file_id": "1",
            "file_name": "test.docx",
            "pages": [
                {"summary": "운영자 매뉴얼", "page_label": "p.1"},
                {"summary": "시스템 관리 설정", "page_label": "p.2"},
            ],
        }
        terms = ["운영자", "매뉴얼", "시스템", "관리", "설정"]
        result = _calculate_coverage(file_index, terms)
        assert result["ratio"] == 1.0
        assert len(result["matched_pages"]) == 2


class TestMatchByKeyword:
    def test_successful_match(self):
        search_items = ["운영자 매뉴얼 시스템 관리 설정"]
        file_indexes = [
            {
                "file_id": "1",
                "file_name": "운영자매뉴얼.docx",
                "pages": [
                    {"summary": "운영자 매뉴얼 시스템 관리 설정 가이드", "page_label": "p.1",
                     "has_match": True, "matched_item_indices": [0]},
                ],
            },
        ]
        matches = match_by_keyword(search_items, file_indexes)
        assert len(matches) == 1
        assert matches[0]["file_id"] == "1"
        assert matches[0]["score"] == 100

    def test_no_match(self):
        search_items = ["운영자 매뉴얼 시스템 관리 설정"]
        file_indexes = [
            {
                "file_id": "1",
                "file_name": "unrelated.docx",
                "pages": [
                    {"summary": "전혀 관련 없는 내용입니다", "page_label": "p.1",
                     "has_match": False, "matched_item_indices": []},
                ],
            },
        ]
        matches = match_by_keyword(search_items, file_indexes)
        assert len(matches) == 1
        assert matches[0]["file_id"] is None

    def test_empty_items(self):
        matches = match_by_keyword([], [])
        assert matches == []

    def test_empty_file_indexes(self):
        matches = match_by_keyword(["test item"], [])
        assert len(matches) == 1
        assert matches[0]["file_id"] is None


class TestFormatPages:
    def test_basic(self):
        assert _format_pages(["p.1", "p.2"]) == "p.1, p.2"

    def test_truncation(self):
        pages = [f"p.{i}" for i in range(1, 11)]
        result = _format_pages(pages)
        assert result.count(",") == 4  # 최대 5개

    def test_empty(self):
        assert _format_pages([]) == ""

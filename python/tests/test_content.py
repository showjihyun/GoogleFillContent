"""
test_content.py: content 모듈 단위 테스트
"""

import pytest
from content import extract_search_terms, _split_into_pages, _quick_match_page, format_file_index


class TestExtractSearchTerms:
    def test_basic_korean(self):
        terms = extract_search_terms("운영자 매뉴얼 시스템 관리")
        assert "운영자" in terms
        assert "매뉴얼" in terms
        assert "시스템" in terms
        assert "관리" in terms

    def test_removes_stop_words(self):
        terms = extract_search_terms("시스템 및 관련 설계 문서 위한 검토")
        assert "및" not in terms
        assert "관련" not in terms
        assert "위한" not in terms
        assert "시스템" in terms
        assert "설계" in terms

    def test_removes_short_words(self):
        terms = extract_search_terms("A B CD EFG")
        assert "A" not in terms
        assert "B" not in terms
        assert "CD" in terms
        assert "EFG" in terms

    def test_deduplication(self):
        terms = extract_search_terms("설계 문서 설계 문서")
        assert terms.count("설계") == 1
        assert terms.count("문서") == 1

    def test_empty_input(self):
        assert extract_search_terms("") == []
        assert extract_search_terms(None) == []

    def test_special_characters(self):
        terms = extract_search_terms("DB설계(ERD)/테이블 정의서")
        assert "DB설계" in terms
        assert "ERD" in terms
        assert "테이블" in terms
        assert "정의서" in terms

    def test_english_stop_words(self):
        terms = extract_search_terms("the system is for authentication")
        assert "the" not in terms
        assert "is" not in terms
        assert "for" not in terms
        assert "system" in terms
        assert "authentication" in terms


class TestSplitIntoPages:
    def test_short_text(self):
        text = "짧은 텍스트"
        pages = _split_into_pages(text, "application/vnd.google-apps.document")
        assert len(pages) == 1
        assert pages[0]["page_num"] == 1
        assert pages[0]["page_label"] == "p.1"

    def test_long_text(self):
        text = "A" * 7500  # 3 페이지
        pages = _split_into_pages(text, "application/vnd.google-apps.document")
        assert len(pages) == 3
        assert pages[0]["page_label"] == "p.1"
        assert pages[2]["page_label"] == "p.3"

    def test_slides_with_separator(self):
        text = "슬라이드1\n---\n슬라이드2\n---\n슬라이드3"
        pages = _split_into_pages(text, "application/vnd.google-apps.presentation")
        assert len(pages) == 3
        assert pages[0]["page_label"] == "슬라이드 1"
        assert pages[2]["page_label"] == "슬라이드 3"

    def test_empty_text(self):
        pages = _split_into_pages("", "text/plain")
        assert len(pages) == 0


class TestQuickMatchPage:
    def test_high_coverage(self):
        page_text = "운영자 매뉴얼은 시스템 관리에 대한 안내서입니다."
        items = ["운영자 매뉴얼 시스템 관리"]
        matched = _quick_match_page(page_text, items)
        assert 0 in matched

    def test_low_coverage(self):
        page_text = "요구사항 분석서 프로젝트 개요"
        items = ["운영자 매뉴얼 시스템 관리 설정 가이드"]
        matched = _quick_match_page(page_text, items)
        assert 0 not in matched

    def test_multiple_items(self):
        page_text = "시스템 설계 문서 아키텍처 구조 다이어그램"
        items = [
            "시스템 설계 아키텍처",       # 매칭 됨
            "테스트 결과 보고서",           # 매칭 안 됨
            "시스템 구조 다이어그램 설계",  # 매칭 됨
        ]
        matched = _quick_match_page(page_text, items)
        assert 0 in matched
        assert 1 not in matched
        assert 2 in matched

    def test_empty_items(self):
        matched = _quick_match_page("some text", ["", None])
        assert matched == []


class TestFormatFileIndex:
    def test_basic_format(self):
        indexes = [
            {
                "file_name": "test.docx",
                "pages": [
                    {"page_label": "p.1", "summary": "첫 페이지 내용"},
                    {"page_label": "p.2", "summary": "두번째 페이지"},
                ],
            }
        ]
        result = format_file_index(indexes)
        assert "[파일 1] test.docx" in result
        assert "p.1: 첫 페이지 내용" in result

    def test_no_pages(self):
        indexes = [{"file_name": "empty.pdf", "pages": []}]
        result = format_file_index(indexes)
        assert "(내용 추출 불가)" in result

    def test_empty_list(self):
        assert format_file_index([]) == ""

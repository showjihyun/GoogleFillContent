"""
test_version.py: version 모듈 단위 테스트
"""

import pytest
from version import extract_base_name, extract_version, get_suffix_priority, resolve_version


class TestExtractBaseName:
    def test_with_version(self):
        assert extract_base_name("설계서_v1.0.docx") == "설계서"
        assert extract_base_name("운영매뉴얼 v2.1.pdf") == "운영매뉴얼"
        assert extract_base_name("테스트계획_V1.0.3.xlsx") == "테스트계획"

    def test_with_suffix(self):
        assert extract_base_name("설계서-final.docx") == "설계서"
        assert extract_base_name("운영매뉴얼_최종.pdf") == "운영매뉴얼"
        assert extract_base_name("테스트-draft.xlsx") == "테스트"
        assert extract_base_name("문서_임시.docx") == "문서"

    def test_with_version_and_suffix(self):
        assert extract_base_name("설계서_v1.0-final.docx") == "설계서"

    def test_no_version_no_suffix(self):
        assert extract_base_name("설계서.docx") == "설계서"
        assert extract_base_name("운영매뉴얼.pdf") == "운영매뉴얼"

    def test_no_extension(self):
        assert extract_base_name("설계서_v1.0") == "설계서"


class TestExtractVersion:
    def test_basic(self):
        assert extract_version("v1.0") == (1, 0, 0)
        assert extract_version("V2.3") == (2, 3, 0)
        assert extract_version("v1.2.3") == (1, 2, 3)

    def test_in_filename(self):
        assert extract_version("설계서_v1.0.docx") == (1, 0, 0)
        assert extract_version("매뉴얼 V2.1.3.pdf") == (2, 1, 3)

    def test_underscore_separator(self):
        assert extract_version("doc_1_0.pdf") == (1, 0, 0)

    def test_no_version(self):
        assert extract_version("설계서.docx") is None
        assert extract_version("매뉴얼.pdf") is None


class TestSuffixPriority:
    def test_high_priority(self):
        assert get_suffix_priority("문서-final.docx") == 1
        assert get_suffix_priority("문서_최종.pdf") == 1
        assert get_suffix_priority("문서-approved.xlsx") == 1
        assert get_suffix_priority("문서_완료.docx") == 1

    def test_low_priority(self):
        assert get_suffix_priority("문서-draft.docx") == -1
        assert get_suffix_priority("문서_임시.pdf") == -1
        assert get_suffix_priority("문서-temp.xlsx") == -1

    def test_normal(self):
        assert get_suffix_priority("문서.docx") == 0
        assert get_suffix_priority("설계서_v1.0.pdf") == 0


class TestResolveVersion:
    def test_single_file(self):
        files = [{"name": "doc.pdf", "id": "1"}]
        result = resolve_version(files)
        assert len(result) == 1
        assert result[0]["id"] == "1"

    def test_picks_latest_version(self):
        files = [
            {"name": "설계서_v1.0.docx", "id": "1", "modifiedTime": "2024-01-01"},
            {"name": "설계서_v2.0.docx", "id": "2", "modifiedTime": "2024-06-01"},
            {"name": "설계서_v1.5.docx", "id": "3", "modifiedTime": "2024-03-01"},
        ]
        result = resolve_version(files)
        assert len(result) == 1
        assert result[0]["id"] == "2"

    def test_prefers_final_over_draft(self):
        files = [
            {"name": "설계서_v1.0-draft.docx", "id": "1", "modifiedTime": "2024-01-01"},
            {"name": "설계서_v1.0-final.docx", "id": "2", "modifiedTime": "2024-01-01"},
        ]
        result = resolve_version(files)
        assert len(result) == 1
        assert result[0]["id"] == "2"

    def test_different_base_names(self):
        files = [
            {"name": "설계서_v1.0.docx", "id": "1", "modifiedTime": "2024-01-01"},
            {"name": "테스트계획_v1.0.docx", "id": "2", "modifiedTime": "2024-01-01"},
        ]
        result = resolve_version(files)
        assert len(result) == 2

    def test_no_version_picks_latest_modified(self):
        files = [
            {"name": "설계서.docx", "id": "1", "modifiedTime": "2024-01-01"},
            {"name": "설계서.docx", "id": "2", "modifiedTime": "2024-06-01"},
        ]
        result = resolve_version(files)
        assert result[0]["id"] == "2"

    def test_empty_list(self):
        assert resolve_version([]) == []

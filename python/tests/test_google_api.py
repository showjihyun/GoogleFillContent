"""
test_google_api.py: google_api 모듈 단위 테스트
"""

import pytest
from google_api import extract_sheet_id, extract_folder_id, _col_to_letter


class TestExtractSheetId:
    def test_full_url(self):
        url = "https://docs.google.com/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz/edit"
        assert extract_sheet_id(url) == "1AbC_dEfGhIjKlMnOpQrStUvWxYz"

    def test_url_with_gid(self):
        url = "https://docs.google.com/spreadsheets/d/1AbC_dEfGhIjKlMnOpQrStUvWxYz/edit#gid=0"
        assert extract_sheet_id(url) == "1AbC_dEfGhIjKlMnOpQrStUvWxYz"

    def test_direct_id(self):
        assert extract_sheet_id("1AbC_dEfGhIjKlMnOpQrStUvWxYz") == "1AbC_dEfGhIjKlMnOpQrStUvWxYz"

    def test_invalid_url(self):
        with pytest.raises(ValueError):
            extract_sheet_id("https://example.com")

    def test_short_id(self):
        with pytest.raises(ValueError):
            extract_sheet_id("abc")


class TestExtractFolderId:
    def test_full_url(self):
        url = "https://drive.google.com/drive/folders/1AbC_dEfGhIjKlMnOpQrStUvWxYz"
        assert extract_folder_id(url) == "1AbC_dEfGhIjKlMnOpQrStUvWxYz"

    def test_url_with_user(self):
        url = "https://drive.google.com/drive/u/0/folders/1AbC_dEfGhIjKlMnOpQrStUvWxYz"
        assert extract_folder_id(url) == "1AbC_dEfGhIjKlMnOpQrStUvWxYz"

    def test_direct_id(self):
        assert extract_folder_id("1AbC_dEfGhIjKlMnOpQrStUvWxYz") == "1AbC_dEfGhIjKlMnOpQrStUvWxYz"

    def test_invalid_url(self):
        with pytest.raises(ValueError):
            extract_folder_id("https://example.com")


class TestColToLetter:
    def test_single_letters(self):
        assert _col_to_letter(0) == "A"
        assert _col_to_letter(1) == "B"
        assert _col_to_letter(25) == "Z"

    def test_double_letters(self):
        assert _col_to_letter(26) == "AA"
        assert _col_to_letter(27) == "AB"
        assert _col_to_letter(51) == "AZ"
        assert _col_to_letter(52) == "BA"

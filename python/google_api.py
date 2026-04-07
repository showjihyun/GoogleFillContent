"""
google_api.py: Google Sheets/Drive 인증 및 래퍼 함수
"""

import logging
import re
import time
from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

log = logging.getLogger("fillcontent")

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]


def build_services(credentials_path: str):
    """서비스 계정 JSON으로 Sheets/Drive 서비스 생성."""
    creds = service_account.Credentials.from_service_account_file(
        credentials_path, scopes=SCOPES
    )
    sheets = build("sheets", "v4", credentials=creds)
    drive = build("drive", "v3", credentials=creds)
    return sheets, drive


def extract_sheet_id(url: str) -> str:
    """스프레드시트 URL에서 ID 추출."""
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]+)", url)
    if m:
        return m.group(1)
    if re.match(r"^[a-zA-Z0-9_-]{10,}$", url.strip()):
        return url.strip()
    raise ValueError(f"유효하지 않은 시트 URL: {url}")


def extract_folder_id(url: str) -> str:
    """Drive 폴더 URL에서 ID 추출."""
    m = re.search(r"/folders/([a-zA-Z0-9_-]+)", url)
    if m:
        return m.group(1)
    if re.match(r"^[a-zA-Z0-9_-]{10,}$", url.strip()):
        return url.strip()
    raise ValueError(f"유효하지 않은 폴더 URL: {url}")


def read_sheet_headers(sheets_service, sheet_id: str, sheet_name: str = None) -> list[str]:
    """시트의 첫 번째 행(헤더)을 읽는다."""
    range_str = f"'{sheet_name}'!1:1" if sheet_name else "1:1"
    result = sheets_service.spreadsheets().values().get(
        spreadsheetId=sheet_id, range=range_str
    ).execute()
    return result.get("values", [[]])[0]


RESULT_COL_HEADER = "산출물 위치(구글드라이브 링크)"
FILENAME_COL_HEADER = "산출물 파일 이름"
REMARKS_COL_HEADER = "비고"


def ensure_output_columns(
    sheets_service, sheet_id: str, sheet_name: str = None
) -> dict[str, int]:
    """산출물 위치, 산출물 파일 이름, 비고 컬럼이 없으면 자동 추가한다.

    Returns:
        {"result_col": int, "filename_col": int, "remarks_col": int}
    """
    headers = read_sheet_headers(sheets_service, sheet_id, sheet_name)
    prefix = f"'{sheet_name}'!" if sheet_name else ""

    needed = [RESULT_COL_HEADER, FILENAME_COL_HEADER, REMARKS_COL_HEADER]
    col_map = {}

    for name in needed:
        # 기존 헤더에서 찾기 (부분 일치도 허용)
        found_idx = None
        for i, h in enumerate(headers):
            if name == h or name in h:
                found_idx = i
                break
        if found_idx is not None:
            col_map[name] = found_idx
        else:
            # 없으면 마지막에 추가
            new_idx = len(headers)
            col_letter = _col_to_letter(new_idx)
            sheets_service.spreadsheets().values().update(
                spreadsheetId=sheet_id,
                range=f"{prefix}{col_letter}1",
                valueInputOption="RAW",
                body={"values": [[name]]},
            ).execute()
            headers.append(name)
            col_map[name] = new_idx
            log.info(f"  컬럼 자동 추가: [{new_idx}] {name}")

    return {
        "result_col": col_map[RESULT_COL_HEADER],
        "filename_col": col_map[FILENAME_COL_HEADER],
        "remarks_col": col_map[REMARKS_COL_HEADER],
    }


def read_search_items(
    sheets_service, sheet_id: str, search_col_indices: list[int],
    sheet_name: str = None
) -> list[str]:
    """검색 기준 컬럼들의 값을 읽어 항목별로 합쳐서 반환한다."""
    range_str = f"'{sheet_name}'" if sheet_name else "Sheet1"
    result = sheets_service.spreadsheets().values().get(
        spreadsheetId=sheet_id, range=range_str
    ).execute()
    rows = result.get("values", [])
    if len(rows) <= 1:
        return []

    items = []
    for row in rows[1:]:  # 헤더 제외
        parts = []
        for idx in search_col_indices:
            if idx < len(row) and str(row[idx]).strip():
                parts.append(str(row[idx]).strip())
        items.append(" ".join(parts))
    return items


class SheetWriter:
    """매칭 결과를 즉시 시트에 기입하는 writer.

    매칭이 완료될 때마다 write()를 호출하면 바로 시트에 반영된다.
    """

    def __init__(
        self, sheets_service, sheet_id: str,
        result_col: int, filename_col: int, remarks_col: int,
        sheet_name: str = None,
    ):
        self._sheets = sheets_service
        self._sheet_id = sheet_id
        self._result_col = result_col
        self._filename_col = filename_col
        self._remarks_col = remarks_col
        self._prefix = f"'{sheet_name}'!" if sheet_name else ""

    def clear(self, total_items: int):
        """기입 전 출력 컬럼 클리어 (이전 실행 잔여 데이터 제거)."""
        last_row = total_items + 1  # 헤더 + 데이터
        cols = [self._result_col]
        if self._filename_col >= 0:
            cols.append(self._filename_col)
        if self._remarks_col >= 0:
            cols.append(self._remarks_col)
        for col in cols:
            col_letter = _col_to_letter(col)
            try:
                self._sheets.spreadsheets().values().clear(
                    spreadsheetId=self._sheet_id,
                    range=f"{self._prefix}{col_letter}2:{col_letter}{last_row}",
                ).execute()
            except Exception:
                pass

    def write(self, matches: list[dict]):
        """매칭 결과를 즉시 시트에 기입한다. 1건이든 N건이든 바로 반영."""
        data = []
        for match in matches:
            row = match["item_index"] + 2
            col_letter = _col_to_letter(self._result_col)

            if match.get("file_id"):
                file_url = f"https://drive.google.com/file/d/{match['file_id']}/view"

                data.append({
                    "range": f"{self._prefix}{col_letter}{row}",
                    "values": [[file_url]],
                })

                if self._filename_col >= 0:
                    fn_letter = _col_to_letter(self._filename_col)
                    data.append({
                        "range": f"{self._prefix}{fn_letter}{row}",
                        "values": [[match["file_name"]]],
                    })

                if self._remarks_col >= 0:
                    remarks_letter = _col_to_letter(self._remarks_col)
                    data.append({
                        "range": f"{self._prefix}{remarks_letter}{row}",
                        "values": [[_format_remarks(match)]],
                    })
            else:
                if self._remarks_col >= 0:
                    remarks_letter = _col_to_letter(self._remarks_col)
                    reason = match.get("reason", "관련 파일 없음")
                    data.append({
                        "range": f"{self._prefix}{remarks_letter}{row}",
                        "values": [[f"매칭 실패\n{reason}"]],
                    })

        if data:
            self._sheets.spreadsheets().values().batchUpdate(
                spreadsheetId=self._sheet_id,
                body={"valueInputOption": "RAW", "data": data},
            ).execute()


def _format_remarks(match: dict) -> str:
    """비고 내용을 줄바꿈으로 구분하여 읽기 쉽게 포맷한다."""
    lines = []
    lines.append(f"AI 점수: {match.get('score', '')}")
    if match.get("page"):
        lines.append(f"위치: {match['page']}")
    if match.get("reason"):
        lines.append(f"사유: {match['reason']}")
    return "\n".join(lines)


def _col_to_letter(col_index: int) -> str:
    """0-based 컬럼 인덱스를 A, B, ..., Z, AA, AB... 형식으로 변환."""
    result = ""
    idx = col_index
    while True:
        result = chr(ord("A") + idx % 26) + result
        idx = idx // 26 - 1
        if idx < 0:
            break
    return result


# --- Drive 헬퍼 ---

def list_child_folders(drive_service, parent_id: str) -> list[dict]:
    """폴더의 하위 폴더 목록 반환."""
    folders = []
    page_token = None
    query = (
        f"'{parent_id}' in parents "
        f"and mimeType = 'application/vnd.google-apps.folder' "
        f"and trashed = false"
    )
    while True:
        params = {
            "q": query,
            "pageSize": 100,
            "fields": "nextPageToken, files(id, name)",
            "supportsAllDrives": True,
            "includeItemsFromAllDrives": True,
        }
        if page_token:
            params["pageToken"] = page_token
        resp = _drive_list_with_retry(drive_service, params)
        folders.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return folders


def list_files_in_folder(drive_service, folder_id: str) -> list[dict]:
    """폴더의 파일 목록 반환 (폴더 제외)."""
    files = []
    page_token = None
    query = (
        f"'{folder_id}' in parents "
        f"and mimeType != 'application/vnd.google-apps.folder' "
        f"and trashed = false"
    )
    while True:
        params = {
            "q": query,
            "pageSize": 100,
            "fields": "nextPageToken, files(id, name, mimeType, modifiedTime, description)",
            "supportsAllDrives": True,
            "includeItemsFromAllDrives": True,
        }
        if page_token:
            params["pageToken"] = page_token
        resp = _drive_list_with_retry(drive_service, params)
        files.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return files


def export_file_as_text(drive_service, file_id: str, mime_type: str) -> str | None:
    """파일을 텍스트로 export한다.

    1차: Google 네이티브 포맷은 Drive export API 사용
    2차: 업로드 파일(PDF, Office, HWP)은 다운로드 후 로컬 파싱
    """
    from file_parser import can_parse, parse_file

    # --- Google 네이티브 포맷: Drive export API ---
    try:
        if mime_type == "application/vnd.google-apps.document":
            resp = drive_service.files().export(
                fileId=file_id, mimeType="text/plain"
            ).execute()
            return resp.decode("utf-8") if isinstance(resp, bytes) else resp

        if mime_type == "application/vnd.google-apps.presentation":
            resp = drive_service.files().export(
                fileId=file_id, mimeType="text/plain"
            ).execute()
            return resp.decode("utf-8") if isinstance(resp, bytes) else resp

        if mime_type == "application/vnd.google-apps.spreadsheet":
            resp = drive_service.files().export(
                fileId=file_id, mimeType="text/csv"
            ).execute()
            return resp.decode("utf-8") if isinstance(resp, bytes) else resp

        if mime_type.startswith("text/"):
            resp = drive_service.files().get_media(fileId=file_id).execute()
            return resp.decode("utf-8") if isinstance(resp, bytes) else resp
    except Exception as e:
        log.debug(f"  Drive export 실패: {e}")

    # --- 업로드 파일: 다운로드 후 로컬 파싱 ---
    if can_parse(mime_type):
        try:
            data = drive_service.files().get_media(fileId=file_id).execute()
            if isinstance(data, bytes) and len(data) > 0:
                result = parse_file(data, mime_type)
                if result:
                    log.debug(f"  로컬 파싱 성공: {mime_type} ({len(result)}자)")
                    return result
                else:
                    log.debug(f"  로컬 파싱: 텍스트 없음 ({mime_type})")
        except Exception as e:
            log.debug(f"  다운로드/파싱 실패: {e}")

    return None


def _extract_pdf_via_copy(drive_service, file_id: str) -> str | None:
    """PDF를 Google Docs로 복사(OCR)하여 텍스트 추출 후 삭제."""
    try:
        copied = drive_service.files().copy(
            fileId=file_id,
            body={
                "name": "_temp_pdf_extract_",
                "mimeType": "application/vnd.google-apps.document",
            },
            ocrLanguage="ko",
        ).execute()
        temp_id = copied["id"]
        text = drive_service.files().export(
            fileId=temp_id, mimeType="text/plain"
        ).execute()
        drive_service.files().delete(fileId=temp_id).execute()
        return text.decode("utf-8") if isinstance(text, bytes) else text
    except Exception:
        return None


def _drive_list_with_retry(drive_service, params, max_retries=3):
    """Drive API 호출 + 재시도."""
    for attempt in range(max_retries):
        try:
            return drive_service.files().list(**params).execute()
        except HttpError as e:
            if e.resp.status == 429 and attempt < max_retries - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            raise

"""
folder_tree.py: 폴더 트리 재귀 수집 + 파일 목록 수집
"""

import logging
from collections import deque
from google_api import list_child_folders, list_files_in_folder


def collect_all_folders(
    root_id: str, drive_service, log: logging.Logger = None
) -> tuple[list[str], dict[str, str]]:
    """BFS로 하위 폴더를 모두 수집한다."""
    if not log:
        log = logging.getLogger("fillcontent")

    folder_ids = [root_id]
    path_map = {root_id: "Root"}
    queue = deque([root_id])

    try:
        meta = drive_service.files().get(
            fileId=root_id, fields="name", supportsAllDrives=True
        ).execute()
        root_name = meta.get("name", "Root")
        path_map[root_id] = root_name
        log.debug(f"  루트 폴더: {root_name} ({root_id})")
    except Exception as e:
        log.warning(f"  루트 폴더 이름 조회 실패: {e}")

    while queue:
        current_id = queue.popleft()
        try:
            children = list_child_folders(drive_service, current_id)
        except Exception as e:
            log.warning(f"  폴더 접근 실패 ({current_id}): {e}")
            continue

        for child in children:
            if child["id"] not in path_map:
                folder_ids.append(child["id"])
                child_path = f"{path_map.get(current_id, '')}/{child['name']}"
                path_map[child["id"]] = child_path
                queue.append(child["id"])
                log.debug(f"  하위 폴더 발견: {child_path}")

    return folder_ids, path_map


def collect_all_files(
    folder_ids: list[str], drive_service, log: logging.Logger = None,
    path_map: dict[str, str] = None,
) -> list[dict]:
    """모든 폴더에서 파일을 수집한다 (중복 제거, 폴더 경로 부여)."""
    if not log:
        log = logging.getLogger("fillcontent")

    all_files = []
    seen_ids = set()

    for folder_id in folder_ids:
        try:
            files = list_files_in_folder(drive_service, folder_id)
        except Exception as e:
            log.warning(f"  파일 수집 실패 ({folder_id}): {e}")
            continue

        folder_path = (path_map or {}).get(folder_id, "")
        for f in files:
            if f["id"] not in seen_ids:
                seen_ids.add(f["id"])
                f["_folder_path"] = folder_path
                all_files.append(f)
                log.debug(f"  파일 수집: {f['name']} [{f.get('mimeType', '?')}] 📁{folder_path}")

    log.debug(f"  총 {len(all_files)}개 파일 수집 (중복 제거 후)")
    return all_files

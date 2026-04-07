"""
FillContent Python CLI — 솔루션 상용화 매뉴얼 산출물 자동 매칭 도구

사용법:
  python main.py \
    --sheet "https://docs.google.com/spreadsheets/d/..." \
    --folder "https://drive.google.com/drive/folders/..." \
    --search-cols 0 1 \
    --result-col 3 \
    --remarks-col 4 \
    --mode ai

매칭 모드:
  ai              AI(LLM) 매칭 — 문맥 분석 후 일괄 매칭 (기본값)
  keyword         키워드(문자열) 매칭 — 커버리지 80% 기준
  keyword_then_ai 키워드 매칭 후 실패 항목만 AI로 재시도

환경변수:
  OPENAI_API_KEY         OpenAI API 키
  GOOGLE_CREDENTIALS_PATH  서비스 계정 JSON 경로 (기본: ./credentials.json)
  OPENAI_MODEL           사용할 모델 (기본: gpt-5.4)
"""

import argparse
import os
import sys
import time

from dotenv import load_dotenv
from tqdm import tqdm

from logger import setup_logger
from google_api import (
    SheetWriter,
    build_services,
    ensure_output_columns,
    extract_folder_id,
    extract_sheet_id,
    read_search_items,
    read_sheet_headers,
)
from folder_tree import collect_all_folders, collect_all_files
from content import index_file
from matcher import create_client, create_matching_plan, match_all
from keyword_matcher import match_by_keyword


def main():
    load_dotenv()

    log = setup_logger()
    args = parse_args()
    creds_path = args.credentials or os.getenv("GOOGLE_CREDENTIALS_PATH", "./credentials.json")
    match_mode = args.mode

    # --- API 키 체크 ---
    log.info("=" * 50)
    log.info("API 키 상태 확인")
    log.info("=" * 50)

    # Google 서비스 계정
    if not os.path.exists(creds_path):
        log.error(f"  Google 서비스 계정 파일 없음: {creds_path}")
        log.error("  .env 파일에 GOOGLE_CREDENTIALS_PATH를 설정하거나 --credentials 옵션을 사용하세요.")
        sys.exit(1)
    log.info(f"  Google 서비스 계정: {creds_path} (OK)")

    # OpenAI API Key — AI 모드일 때만 필수
    openai_key = os.getenv("OPENAI_API_KEY", "")
    if match_mode in ("ai", "keyword_then_ai"):
        if not openai_key:
            log.error("  OPENAI_API_KEY: 미설정")
            log.error("  .env 파일에 OPENAI_API_KEY를 설정하세요.")
            sys.exit(1)
        masked_key = openai_key[:8] + "..." + openai_key[-4:] if len(openai_key) > 12 else "***"
        log.info(f"  OPENAI_API_KEY: {masked_key} (OK)")
    else:
        if openai_key:
            masked_key = openai_key[:8] + "..." + openai_key[-4:] if len(openai_key) > 12 else "***"
            log.info(f"  OPENAI_API_KEY: {masked_key} (설정됨, keyword 모드에서 미사용)")
        else:
            log.info(f"  OPENAI_API_KEY: 미설정 (keyword 모드에서 불필요)")

    # OpenAI 모델
    openai_model = os.getenv("OPENAI_MODEL", "gpt-5.4")
    log.info(f"  OPENAI_MODEL: {openai_model}")

    # Gemini API Key (선택)
    gemini_key = os.getenv("GEMINI_API_KEY", "")
    if gemini_key:
        masked_gemini = gemini_key[:8] + "..." + gemini_key[-4:] if len(gemini_key) > 12 else "***"
        log.info(f"  GEMINI_API_KEY: {masked_gemini} (설정됨, 현재 미사용)")
    else:
        log.info(f"  GEMINI_API_KEY: 미설정 (선택사항)")

    log.info("")

    sheet_id = extract_sheet_id(args.sheet)
    folder_id = extract_folder_id(args.folder)

    log.info(f"시트: {sheet_id}")
    log.info(f"폴더: {folder_id}")
    log.info(f"검색 컬럼: {args.search_cols}")
    log.info(f"출력 컬럼: 자동 감지 (--result-col={args.result_col}, --filename-col={args.filename_col}, --remarks-col={args.remarks_col})")
    log.info(f"매칭 모드: {match_mode}")
    log.info("")

    # --- 서비스 초기화 ---
    log.info("Google API 인증 중...")
    sheets_service, drive_service = build_services(creds_path)
    openai_client = None
    if match_mode in ("ai", "keyword_then_ai"):
        openai_client = create_client()
    log.info("인증 완료")

    # 헤더 확인 + 출력 컬럼 자동 감지/추가
    headers = read_sheet_headers(sheets_service, sheet_id, args.sheet_name)
    if headers:
        log.info(f"시트 헤더: {headers}")

    log.info("")
    log.info("출력 컬럼 확인...")
    output_cols = ensure_output_columns(sheets_service, sheet_id, args.sheet_name)
    result_col = args.result_col if args.result_col >= 0 else output_cols["result_col"]
    filename_col = args.filename_col if args.filename_col >= 0 else output_cols["filename_col"]
    remarks_col = args.remarks_col if args.remarks_col >= 0 else output_cols["remarks_col"]
    log.info(f"  산출물 위치 컬럼: [{result_col}]")
    log.info(f"  파일 이름 컬럼: [{filename_col}]")
    log.info(f"  비고 컬럼: [{remarks_col}]")

    # --- Phase 1: 시트 항목 읽기 ---
    log.info("")
    log.info("=" * 50)
    log.info("Phase 1: 시트 항목 읽기")
    log.info("=" * 50)
    search_items = read_search_items(
        sheets_service, sheet_id, args.search_cols, args.sheet_name
    )
    search_items = [item for item in search_items if item.strip()]
    log.info(f"  {len(search_items)}개 항목 로드 완료")
    for i, item in enumerate(search_items):
        log.debug(f"  항목[{i}]: {item[:100]}")

    if not search_items:
        log.error("검색할 항목이 없습니다.")
        sys.exit(1)

    # --- Phase 2: 폴더 트리 수집 ---
    log.info("")
    log.info("=" * 50)
    log.info("Phase 2: 폴더 트리 수집")
    log.info("=" * 50)
    start = time.time()
    folder_ids, path_map = collect_all_folders(folder_id, drive_service, log)
    elapsed = time.time() - start
    log.info(f"  {len(folder_ids)}개 폴더 발견 ({elapsed:.1f}초)")
    for fid, path in path_map.items():
        log.debug(f"  폴더: {path} ({fid})")

    # --- Phase 3: 파일 목록 수집 + 내용 인덱싱 ---
    log.info("")
    log.info("=" * 50)
    log.info("Phase 3: 파일 수집 + 내용 인덱싱")
    log.info("=" * 50)
    all_files = collect_all_files(folder_ids, drive_service, log, path_map)
    log.info(f"  {len(all_files)}개 파일 발견")
    for f in all_files:
        log.debug(f"  파일: {f['name']} ({f['id']}) [{f.get('mimeType', '?')}]")

    if not all_files:
        log.error("폴더에 파일이 없습니다.")
        sys.exit(1)

    file_indexes = []
    for f in tqdm(all_files, desc="  인덱싱", unit="파일"):
        idx = index_file(f, search_items, drive_service, log)
        file_indexes.append(idx)

    indexed_count = sum(1 for fi in file_indexes if fi["pages"])
    log.info(f"  {indexed_count}/{len(all_files)}개 파일 내용 추출 성공")
    for fi in file_indexes:
        page_count = len(fi["pages"])
        matched = sum(1 for p in fi["pages"] if p["has_match"])
        log.debug(f"  인덱스: {fi['file_name']} — {page_count}페이지, {matched}페이지 매칭 후보")

    # --- SheetWriter 준비 (매칭 즉시 기입) ---
    writer = SheetWriter(
        sheets_service, sheet_id,
        result_col, filename_col, remarks_col,
        args.sheet_name,
    )
    writer.clear(len(search_items))
    log.info("  출력 컬럼 초기화 완료 — 매칭 결과 즉시 기입 모드")

    # --- Phase 4+5: 매칭 (모드별 분기, 즉시 기입) ---
    matches = _run_matching(match_mode, search_items, file_indexes, openai_client, log, writer)

    # --- 요약 ---
    _print_summary(matches, search_items, log)

    log.info("")
    log.info("완료")


def _run_matching(match_mode, search_items, file_indexes, openai_client, log, writer=None):
    """매칭 모드에 따라 적절한 매칭을 실행한다."""
    on_matches = writer.write if writer else None

    if match_mode == "keyword":
        # 키워드(문자열) 매칭만
        log.info("")
        log.info("=" * 50)
        log.info("Phase 4: 키워드 매칭 실행")
        log.info("=" * 50)
        matches = match_by_keyword(search_items, file_indexes, log)
        if on_matches:
            on_matches(matches)
        log.info(f"  {len(matches)}개 항목 처리 완료")
        _log_match_details(matches, search_items, log)
        return matches

    if match_mode == "keyword_then_ai":
        # 1차: 키워드 매칭
        log.info("")
        log.info("=" * 50)
        log.info("Phase 4a: 키워드 매칭 (1차)")
        log.info("=" * 50)
        keyword_matches = match_by_keyword(search_items, file_indexes, log)
        success = sum(1 for m in keyword_matches if m.get("file_id"))
        fail = sum(1 for m in keyword_matches if not m.get("file_id"))
        log.info(f"  1차 결과: 성공 {success}개, 실패 {fail}개")

        if on_matches:
            on_matches(keyword_matches)

        if fail == 0:
            log.info("  모든 항목 키워드 매칭 성공 — AI 매칭 생략")
            _log_match_details(keyword_matches, search_items, log)
            return keyword_matches

        # 2차: 실패 항목만 AI 매칭
        log.info("")
        log.info("=" * 50)
        log.info("Phase 4b: AI 매칭 (실패 항목 재시도)")
        log.info("=" * 50)

        failed_indices = [m["item_index"] for m in keyword_matches if not m.get("file_id")]
        failed_items = [search_items[i] for i in failed_indices]
        log.info(f"  {len(failed_items)}개 항목 AI 재시도")

        matching_plan = create_matching_plan(failed_items, openai_client, log)
        ai_matches = match_all(failed_items, file_indexes, matching_plan, openai_client, log, on_matches=on_matches)

        # AI 매칭 결과의 item_index를 원래 인덱스로 보정
        ai_match_map = {}
        for ai_m in ai_matches:
            original_idx = failed_indices[ai_m["item_index"]]
            ai_m["item_index"] = original_idx
            ai_match_map[original_idx] = ai_m

        # 키워드 결과와 AI 결과 병합
        final_matches = []
        for m in keyword_matches:
            if m.get("file_id"):
                final_matches.append(m)
            elif m["item_index"] in ai_match_map:
                final_matches.append(ai_match_map[m["item_index"]])
            else:
                final_matches.append(m)

        _log_match_details(final_matches, search_items, log)
        return final_matches

    # AI 모드 (기본)
    log.info("")
    log.info("=" * 50)
    log.info("Phase 4: AI 매칭 계획 수립")
    log.info("=" * 50)
    matching_plan = create_matching_plan(search_items, openai_client, log)
    if matching_plan:
        log.info(f"  도메인: {matching_plan.get('domain', '?')}")
        log.info(f"  프로젝트 유형: {matching_plan.get('projectType', '?')}")
        log.debug(f"  매칭 계획 전체: {matching_plan}")
    else:
        log.warning("  매칭 계획 수립 실패 — 기본 매칭으로 진행")

    log.info("")
    log.info("=" * 50)
    log.info("Phase 5: AI 매칭 실행")
    log.info("=" * 50)
    matches = match_all(search_items, file_indexes, matching_plan, openai_client, log, on_matches=on_matches)
    log.info(f"  {len(matches)}개 항목 처리 완료")
    _log_match_details(matches, search_items, log)
    return matches


def _log_match_details(matches, search_items, log):
    """매칭 결과 상세를 로그에 기록한다."""
    for m in matches:
        idx = m["item_index"]
        item_name = search_items[idx][:50] if idx < len(search_items) else "?"
        if m.get("file_id"):
            log.debug(
                f"  매칭[{idx}]: {item_name} → {m['file_name']} "
                f"(점수: {m.get('score', '?')}, {m.get('reason', '')})"
            )
        else:
            log.debug(f"  매칭[{idx}]: {item_name} → 실패 ({m.get('reason', '?')})")


def _print_summary(matches, search_items, log):
    """결과 요약을 출력한다."""
    success = sum(1 for m in matches if m.get("file_id"))
    fail = sum(1 for m in matches if not m.get("file_id"))
    high_score = sum(1 for m in matches if m.get("score", 0) >= 80)

    log.info("")
    log.info("=" * 50)
    log.info("결과 요약")
    log.info("=" * 50)
    log.info(f"  전체 항목: {len(search_items)}개")
    log.info(f"  매칭 성공: {success}개 (확실: {high_score}개)")
    log.info(f"  매칭 실패: {fail}개")

    if fail > 0:
        log.info("")
        log.info("매칭 실패 항목:")
        for m in matches:
            if not m.get("file_id"):
                idx = m["item_index"]
                item_name = search_items[idx][:50] if idx < len(search_items) else "?"
                log.info(f"  [{idx + 1}] {item_name} — {m.get('reason', '알 수 없음')}")


def parse_args():
    # CLI 인자가 없으면 대화형 입력 모드
    if len(sys.argv) == 1:
        return _interactive_input()

    parser = argparse.ArgumentParser(
        description="FillContent — 솔루션 상용화 매뉴얼 산출물 자동 매칭 도구"
    )
    parser.add_argument(
        "--sheet", required=True,
        help="Google Sheets URL 또는 ID"
    )
    parser.add_argument(
        "--folder", required=True,
        help="Google Drive 폴더 URL 또는 ID"
    )
    parser.add_argument(
        "--search-cols", type=int, nargs="+", required=True,
        help="검색 기준 컬럼 인덱스 (0-based, 복수 가능)"
    )
    parser.add_argument(
        "--result-col", type=int, default=-1,
        help="산출물 위치 컬럼 인덱스 (0-based, 생략 시 자동 감지/추가)"
    )
    parser.add_argument(
        "--filename-col", type=int, default=-1,
        help="산출물 파일 이름 컬럼 인덱스 (0-based, 생략 시 자동 감지/추가)"
    )
    parser.add_argument(
        "--remarks-col", type=int, default=-1,
        help="비고 컬럼 인덱스 (0-based, 생략 시 자동 감지/추가)"
    )
    parser.add_argument(
        "--mode", choices=["ai", "keyword", "keyword_then_ai"], default="ai",
        help="매칭 모드: ai(기본), keyword(문자열), keyword_then_ai(키워드→AI)"
    )
    parser.add_argument(
        "--sheet-name", default=None,
        help="시트 이름 (기본: 첫 번째 시트)"
    )
    parser.add_argument(
        "--credentials", default=None,
        help="Google 서비스 계정 JSON 경로 (기본: GOOGLE_CREDENTIALS_PATH 환경변수 또는 ./credentials.json)"
    )
    return parser.parse_args()


def _interactive_input():
    """대화형으로 매개변수를 입력받는다."""
    print("=" * 50)
    print("FillContent — 산출물 자동 매칭 도구")
    print("=" * 50)
    print()

    # 시트 URL
    sheet = input("Google Sheets URL 또는 ID: ").strip()
    if not sheet:
        print("시트 URL은 필수입니다.")
        sys.exit(1)

    # 폴더 URL
    folder = input("Google Drive 폴더 URL 또는 ID: ").strip()
    if not folder:
        print("폴더 URL은 필수입니다.")
        sys.exit(1)

    # 시트 이름 — 헤더 표시를 위해 먼저 인증
    load_dotenv()
    creds_path = os.getenv("GOOGLE_CREDENTIALS_PATH", "./credentials.json")
    if os.path.exists(creds_path):
        try:
            from google_api import build_services, extract_sheet_id, read_sheet_headers
            sheets_svc, _ = build_services(creds_path)
            sid = extract_sheet_id(sheet)

            # 시트 목록 표시
            meta = sheets_svc.spreadsheets().get(spreadsheetId=sid).execute()
            sheet_list = [s["properties"]["title"] for s in meta["sheets"]]
            print(f"\n시트 목록:")
            for i, name in enumerate(sheet_list):
                print(f"  [{i}] {name}")
            sheet_idx = input(f"시트 번호 선택 (기본: 0): ").strip()
            sheet_name = sheet_list[int(sheet_idx)] if sheet_idx else sheet_list[0]
            print(f"  → {sheet_name}")

            # 헤더 표시
            headers = read_sheet_headers(sheets_svc, sid, sheet_name)
            print(f"\n컬럼 목록:")
            for i, h in enumerate(headers):
                print(f"  [{i}] {h}")
        except Exception as e:
            print(f"\n시트 접근 실패: {e}")
            sheet_name = input("시트 이름 직접 입력: ").strip() or None
            headers = None
    else:
        sheet_name = input("시트 이름 (엔터=첫번째 시트): ").strip() or None
        headers = None

    # 검색 기준 컬럼
    search_cols_str = input("\n검색 기준 컬럼 번호 (복수는 공백 구분, 예: 3 5): ").strip()
    if not search_cols_str:
        print("검색 기준 컬럼은 필수입니다.")
        sys.exit(1)
    search_cols = [int(x) for x in search_cols_str.split()]

    # 출력 컬럼 (자동 감지 안내)
    print("\n출력 컬럼 (엔터=자동 감지/추가):")
    result_col_str = input("  산출물 위치 컬럼 번호 (엔터=자동): ").strip()
    filename_col_str = input("  산출물 파일 이름 컬럼 번호 (엔터=자동): ").strip()
    remarks_col_str = input("  비고 컬럼 번호 (엔터=자동): ").strip()

    # 매칭 모드
    print("\n매칭 모드:")
    print("  [1] ai — AI(LLM) 매칭 (기본)")
    print("  [2] keyword — 키워드(문자열) 매칭")
    print("  [3] keyword_then_ai — 키워드 1차 → 실패만 AI 재시도")
    mode_input = input("선택 (1/2/3, 기본=1): ").strip()
    mode_map = {"1": "ai", "2": "keyword", "3": "keyword_then_ai", "": "ai"}
    mode = mode_map.get(mode_input, "ai")

    # credentials
    credentials = input(f"\n서비스 계정 JSON 경로 (엔터={creds_path}): ").strip() or None

    print()

    # argparse.Namespace 호환 객체 생성
    class Args:
        pass

    args = Args()
    args.sheet = sheet
    args.folder = folder
    args.search_cols = search_cols
    args.result_col = int(result_col_str) if result_col_str else -1
    args.filename_col = int(filename_col_str) if filename_col_str else -1
    args.remarks_col = int(remarks_col_str) if remarks_col_str else -1
    args.mode = mode
    args.sheet_name = sheet_name
    args.credentials = credentials
    return args


if __name__ == "__main__":
    main()

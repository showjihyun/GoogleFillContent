# FillContent Python CLI — SPEC

## 1. 개요

솔루션 상용화 표준 매뉴얼의 산출물 항목을 Google Drive 폴더 내 파일과 자동 매칭하는 CLI 도구.
기존 Google Apps Script 버전을 Python으로 전환하여 실행 시간 제한 해소, AI 매칭 정확도 향상.

---

## 2. 시스템 아키텍처

### 2.1 모듈 구조

```
main.py                          CLI 진입점 + 오케스트레이터
│
├── google_api.py                Google API 래퍼
│   ├── build_services()         Sheets/Drive 인증
│   ├── SheetWriter              즉시 기입 클래스
│   ├── ensure_output_columns()  출력 컬럼 자동 감지/추가
│   ├── export_file_as_text()    파일 텍스트 추출 (API + 로컬 파싱)
│   └── read/write 헬퍼          시트 읽기, URL 파싱, 컬럼 변환
│
├── folder_tree.py               폴더/파일 수집
│   ├── collect_all_folders()    BFS 폴더 탐색
│   └── collect_all_files()      파일 수집 + 경로 부여
│
├── content.py                   내용 추출 + 인덱싱
│   ├── index_file()             파일 → 페이지 분할 → 빠른 매칭
│   ├── extract_search_terms()   핵심 용어 추출
│   └── format_file_index()      AI 프롬프트용 포맷
│
├── file_parser.py               로컬 파일 파싱 (바이너리 → 텍스트)
│   ├── parse_pdf()              pdfplumber
│   ├── parse_pptx()             python-pptx (슬라이드+테이블)
│   ├── parse_xlsx()             openpyxl (시트별 셀)
│   ├── parse_docx()             python-docx (단락+테이블)
│   ├── parse_hwp()              olefile + zlib (BodyText 섹션)
│   └── parse_doc/xls()          olefile (OLE 스트림)
│
├── matcher.py                   AI(LLM) 매칭
│   ├── create_matching_plan()   시트 전체 분석 → 매칭 전략
│   ├── match_all()              청크 매칭 + 즉시 기입 + 2차 검증
│   └── _verify_low_scores()     저점수 항목 재확인
│
├── keyword_matcher.py           키워드(문자열) 매칭
│   ├── match_by_keyword()       커버리지 80% 기준 매칭
│   └── _calculate_coverage()    용어 포함률 계산
│
├── version.py                   파일 버전 해석
│   ├── resolve_version()        기본명 그룹핑 → 최신 버전 선택
│   └── extract_version()        v1.0, V2.1.3 패턴 파싱
│
└── logger.py                    UTF-8 파일/콘솔 로깅
```

### 2.2 모듈 의존관계

```
main.py
├─→ google_api.py ──→ file_parser.py
├─→ folder_tree.py ─→ google_api.py
├─→ content.py ────→ google_api.py
├─→ matcher.py ────→ content.py
├─→ keyword_matcher.py
│   ├─→ content.py
│   └─→ version.py
└─→ logger.py
```

### 2.3 외부 시스템 연동

```
┌──────────────┐     Sheets API v4      ┌──────────────────┐
│              │◄───────────────────────►│  Google Sheets   │
│              │     (읽기/쓰기)         │  (검색 항목 +    │
│              │                         │   결과 기입)     │
│              │                         └──────────────────┘
│              │
│  FillContent │     Drive API v3        ┌──────────────────┐
│  Python CLI  │◄───────────────────────►│  Google Drive    │
│              │     (폴더탐색/          │  (산출물 파일    │
│              │      파일다운로드)       │   저장소)        │
│              │                         └──────────────────┘
│              │
│              │     Chat Completions    ┌──────────────────┐
│              │◄───────────────────────►│  OpenAI API      │
│              │     (JSON 응답 모드)     │  (GPT-5.4)       │
└──────────────┘                         └──────────────────┘
       │
       ▼
  log/fillcontent_YYYYMMDD_HHMMSS.log
```

---

## 3. Process Flow

### 3.1 전체 흐름

```
┌─────────────────────────────────────────────────────────┐
│  실행 시작 (CLI 인자 또는 대화형 입력)                    │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│  API 키 검증                                             │
│  - Google 서비스 계정 (credentials.json)                  │
│  - OpenAI API Key (AI 모드 시 필수)                       │
│  - Gemini API Key (선택, 현재 미사용)                     │
└────────────────────────┬────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────┐
│  출력 컬럼 자동 감지/추가                                 │
│  - "산출물 위치(구글드라이브 링크)" 컬럼 확인/생성         │
│  - "산출물 파일 이름" 컬럼 확인/생성                      │
│  - "비고" 컬럼 확인/생성                                  │
│  - 기존 출력 컬럼 클리어 (이전 실행 잔여 데이터 제거)      │
└────────────────────────┬────────────────────────────────┘
                         ▼
          ┌──────────────────────────────┐
          │  Phase 1: 시트 항목 읽기      │
          │  검색 기준 컬럼(복수) 합산     │
          │  → search_items: list[str]   │
          └──────────────┬───────────────┘
                         ▼
          ┌──────────────────────────────┐
          │  Phase 2: 폴더 트리 수집      │
          │  BFS 재귀 탐색               │
          │  → folder_ids + path_map     │
          └──────────────┬───────────────┘
                         ▼
          ┌──────────────────────────────┐
          │  Phase 3: 파일 수집 + 인덱싱  │
          │  ┌────────────────────────┐  │
          │  │ 파일별 처리:            │  │
          │  │ 1. Drive에서 다운로드   │  │
          │  │ 2. 로컬 파싱(텍스트화)  │  │
          │  │ 3. 페이지 분할          │  │
          │  │ 4. 빠른 매칭 체크       │  │
          │  └────────────────────────┘  │
          │  → file_indexes: list[dict]  │
          └──────────────┬───────────────┘
                         ▼
               ┌─────────┴─────────┐
               ▼                   ▼
     ┌─────────────┐     ┌─────────────────┐
     │ mode=keyword │     │ mode=ai (기본)   │
     └──────┬──────┘     └────────┬────────┘
            ▼                     ▼
  ┌──────────────────┐  ┌──────────────────────┐
  │ Phase 4:          │  │ Phase 4:              │
  │ 키워드 매칭       │  │ AI 매칭 계획 수립      │
  │ 커버리지 80%      │  │ → 도메인, 생명주기     │
  │ → 즉시 시트 기입  │  └──────────┬───────────┘
  └──────┬───────────┘             ▼
         │              ┌──────────────────────┐
         │              │ Phase 5:              │
         │              │ AI 청크 매칭 (20개씩)  │
         │              │ → 청크 완료마다        │
         │              │   즉시 시트 기입       │
         │              │                       │
         │              │ 2차 검증 (<65점)       │
         │              │ → 교체/제거 시         │
         │              │   즉시 시트 업데이트    │
         │              └──────────┬───────────┘
         └──────────┬──────────────┘
                    ▼
          ┌──────────────────────────────┐
          │  결과 요약 출력               │
          │  - 전체/성공/실패 건수        │
          │  - 실패 항목 목록             │
          └──────────────────────────────┘
```

### 3.2 Phase별 상세

#### Phase 1: 시트 항목 읽기

```
Sheets API → 헤더 행 조회
           → 전체 데이터 조회
           → 검색 기준 컬럼(복수) 값 합산
           → 빈 항목 필터링
```

#### Phase 2: 폴더 트리 수집

```
루트 폴더 ID
    │
    ▼
BFS Queue: [root]
    │
    ├── Drive API: 하위 폴더 목록 조회
    ├── queue에 추가 + path_map에 경로 기록
    └── 반복 (queue가 빌 때까지)
    │
    ▼
결과: folder_ids[], path_map{id→경로}
```

#### Phase 3: 파일 수집 + 인덱싱

```
폴더별 파일 목록 조회 (Drive API)
    │
    ▼
파일별 내용 추출:
    ├── Google 네이티브 (Docs/Slides/Sheets)
    │   └── Drive export API → text/plain 또는 text/csv
    │
    └── 업로드 파일 (PDF/PPTX/XLSX/DOCX/HWP/DOC/XLS)
        └── Drive get_media → 바이너리 다운로드
            └── file_parser.py → 로컬 파싱 → 텍스트
    │
    ▼
페이지 분할:
    ├── Slides/PPTX → 슬라이드 단위
    └── 기타 → 2,500자 단위
    │
    ▼
빠른 매칭 체크 (30% 용어 포함 시 후보):
    └── 3페이지 이상 읽고 매칭 발견 시 조기 종료

결과: file_index = {
    file_id, file_name, folder_path,
    pages: [{page_num, page_label, summary(1000자), matched_item_indices}]
}
```

#### Phase 4: 매칭 계획 수립 (AI 모드)

```
전체 항목 목록 → OpenAI 프롬프트
    │
    ▼
응답 JSON:
{
    "domain": "B2G/B2B 솔루션 상용화",
    "projectType": "GeoAI 플랫폼 제품화",
    "lifecycle": "기획→설계→개발→테스트→배포→운영",
    "namingConventions": [...],
    "searchStrategy": "..."
}
```

#### Phase 5: 매칭 실행 + 즉시 기입

```
항목을 20개씩 청크 분할
    │
    ▼
청크별 처리:
    ├── 항목 목록 + 파일 인덱스(경로+내용) → OpenAI 프롬프트
    ├── 응답: [{itemIndex, fileIndex, page, score, reason}, ...]
    ├── ★ SheetWriter.write() → 즉시 시트 기입
    └── 다음 청크로
    │
    ▼
2차 검증 (score < 65):
    ├── 현재 파일 전체 내용 + 대안 후보 5개 → OpenAI
    ├── 판단: keep(유지) / replace(교체) / none(제거)
    └── ★ SheetWriter.write() → 변경 즉시 시트 반영
```

### 3.3 매칭 모드별 분기

```
         ┌──────────────────┐
         │    --mode 옵션    │
         └────────┬─────────┘
                  │
    ┌─────────────┼─────────────┐
    ▼             ▼             ▼
 keyword      keyword_then_ai    ai
    │             │              │
    │      ┌──────┴──────┐      │
    │      ▼             │      │
    │  1차: keyword      │      │
    │  매칭              │      │
    │      │             │      │
    │      ├─ 성공 →     │      │
    │      │   시트 기입  │      │
    │      │             │      │
    │      ├─ 실패 →     │      │
    │      │   AI 재시도  │      │
    │      │      │      │      │
    │      │      ▼      │      │
    │      │   2차: ai   │      │
    │      │   매칭      │      │
    │      │      │      │      │
    ▼      ▼      ▼      │      ▼
 결과 합산 + 즉시 기입     │   AI 매칭
                          │   (계획수립 →
                          │    청크매칭 →
                          │    2차검증)
                          │      │
                          ▼      ▼
                        최종 결과
```

---

## 4. 데이터 모델

### 4.1 주요 데이터 구조

```
search_item: str
  "검색 기준 컬럼1 값 검색 기준 컬럼2 값" (공백 합산)

file_index: dict
  {
    "file_id": "Drive 파일 ID",
    "file_name": "파일명.pptx",
    "folder_path": "루트폴더/하위폴더/...",
    "pages": [
      {
        "page_num": 1,
        "page_label": "p.1" 또는 "슬라이드 1",
        "summary": "페이지 내용 (최대 1000자)",
        "matched_item_indices": [0, 3, 7],
        "has_match": true
      }
    ],
    "fully_indexed": true
  }

match_result: dict
  {
    "item_index": 0,           # 0-based 항목 인덱스
    "file_id": "Drive 파일 ID",
    "file_name": "매칭된 파일명",
    "page": "p.3",             # 관련 페이지
    "score": 92,               # 0-100
    "reason": "매칭 사유"
  }
```

### 4.2 시트 출력 구조

| 컬럼 | 내용 | 예시 |
|------|------|------|
| 산출물 위치 | 구글드라이브 링크만 | `https://drive.google.com/file/d/.../view` |
| 산출물 파일 이름 | 파일명만 | `GEOAI_운영자_매뉴얼_v1.2.pptx` |
| 비고 | 줄바꿈 구분 | `AI 점수: 95`<br>`위치: 슬라이드 2-6`<br>`사유: 운영자 매뉴얼이 직접 존재` |

---

## 5. 실행 방법

### 5.1 환경 설정

```bash
cd python/
uv venv
uv pip install -r requirements.txt
```

### 5.2 CLI 실행

```bash
# 대화형 모드 (인자 없이 실행)
uv run python main.py

# CLI 인자 모드 (최소)
uv run python main.py \
  --sheet "시트 URL 또는 ID" \
  --folder "Drive 폴더 URL 또는 ID" \
  --search-cols 3 5 \
  --sheet-name "GEOAI v1.0"

# CLI 인자 모드 (전체 지정)
uv run python main.py \
  --sheet "시트 URL 또는 ID" \
  --folder "Drive 폴더 URL 또는 ID" \
  --search-cols 3 5 \
  --result-col 7 --filename-col 8 --remarks-col 9 \
  --mode ai \
  --sheet-name "GEOAI v1.0"
```

### 5.3 CLI 옵션

| 옵션 | 필수 | 기본값 | 설명 |
|------|------|--------|------|
| `--sheet` | O | - | Google Sheets URL 또는 ID |
| `--folder` | O | - | Google Drive 폴더 URL 또는 ID |
| `--search-cols` | O | - | 검색 기준 컬럼 인덱스 (0-based, 복수) |
| `--result-col` | - | 자동 감지 | 산출물 위치 컬럼 |
| `--filename-col` | - | 자동 감지 | 산출물 파일 이름 컬럼 |
| `--remarks-col` | - | 자동 감지 | 비고 컬럼 |
| `--mode` | - | `ai` | `ai` / `keyword` / `keyword_then_ai` |
| `--sheet-name` | - | 첫번째 시트 | 대상 시트 이름 |
| `--credentials` | - | `./credentials.json` | 서비스 계정 JSON 경로 |

### 5.4 대화형 모드

인자 없이 `python main.py` 실행 시:
1. 시트 URL 입력
2. 폴더 URL 입력
3. 시트 목록 표시 → 번호 선택
4. 컬럼 목록 표시 → 검색 기준 컬럼 번호 입력
5. 출력 컬럼 (엔터=자동)
6. 매칭 모드 선택 (1/2/3)

---

## 6. 설정

### 6.1 환경변수 (.env)

| 변수 | 필수 | 기본값 | 설명 |
|------|------|--------|------|
| `OPENAI_API_KEY` | AI 모드 시 | - | OpenAI API 키 |
| `OPENAI_MODEL` | - | `gpt-5.4` | 사용 모델 |
| `GOOGLE_CREDENTIALS_PATH` | - | `./credentials.json` | 서비스 계정 JSON |
| `GEMINI_API_KEY` | - | - | 향후 확장용 (현재 미사용) |

### 6.2 주요 상수

| 상수 | 파일 | 값 | 설명 |
|------|------|-----|------|
| `CHARS_PER_PAGE` | content.py | 2,500 | 페이지 분할 단위 (자) |
| `PAGE_SUMMARY_LENGTH` | content.py | 1,000 | 페이지당 AI 전달 요약 길이 |
| `MAX_PAGES_PER_FILE` | content.py | 50 | 파일당 최대 인덱싱 페이지 |
| `CHUNK_SIZE` | matcher.py | 20 | AI 매칭 청크 크기 (항목 수) |
| `VERIFY_THRESHOLD` | matcher.py | 65 | 2차 검증 트리거 점수 |
| `COVERAGE_THRESHOLD` | keyword_matcher.py | 0.8 | 키워드 매칭 커버리지 기준 (80%) |

---

## 7. 파일 내용 추출

| 파일 유형 | MIME Type | 추출 방식 | 라이브러리 |
|-----------|-----------|----------|-----------|
| Google Docs | `vnd.google-apps.document` | Drive export API | - |
| Google Slides | `vnd.google-apps.presentation` | Drive export API | - |
| Google Sheets | `vnd.google-apps.spreadsheet` | Drive export API (CSV) | - |
| PDF | `application/pdf` | 다운로드 → 로컬 파싱 | pdfplumber |
| PPTX | `officedocument.presentationml` | 다운로드 → 로컬 파싱 | python-pptx |
| XLSX | `officedocument.spreadsheetml` | 다운로드 → 로컬 파싱 | openpyxl |
| DOCX | `officedocument.wordprocessingml` | 다운로드 → 로컬 파싱 | python-docx |
| DOC/XLS | `msword` / `vnd.ms-excel` | 다운로드 → OLE 파싱 | olefile |
| HWP | `application/x-hwp` | 다운로드 → zlib + OLE | olefile |
| 텍스트 | `text/*` | Drive 직접 다운로드 | - |

---

## 8. 로깅

- 파일: `log/fillcontent_YYYYMMDD_HHMMSS.log`
- 콘솔: INFO 이상 / 파일: DEBUG 이상 (UTF-8)
- 기록: API 키 상태, Phase 진행, 파일별 인덱싱, 매칭 상세, OpenAI 토큰 사용량

---

## 9. 테스트

```bash
uv run pytest tests/ -v
```

| 파일 | 대상 | 테스트 항목 |
|------|------|-----------|
| `test_google_api.py` | google_api.py | URL 파싱, 컬럼 인덱스 변환 |
| `test_content.py` | content.py | 용어 추출, 페이지 분할, 빠른 매칭, 포맷 |
| `test_version.py` | version.py | 기본명 추출, 버전 파싱, 접미사, 버전 해석 |
| `test_keyword_matcher.py` | keyword_matcher.py | 커버리지 계산, 매칭, 페이지 포맷 |
| `test_matcher.py` | matcher.py | 항목 빌드, AI 매칭(mock), 매칭 계획(mock) |
| `test_logger.py` | logger.py | 로그 디렉토리/파일, 핸들러 레벨 |

---

## 10. 의존성

```
google-api-python-client>=2.0
google-auth>=2.0
google-auth-oauthlib>=1.0
openai>=1.0
tqdm>=4.0
python-dotenv>=1.0
pdfplumber>=0.11
python-pptx>=1.0
openpyxl>=3.1
python-docx>=1.0
olefile>=0.47
pytest>=8.0
```

---

## 11. Apps Script 대비 변경점

| 항목 | Apps Script | Python CLI |
|------|-------------|------------|
| 실행 시간 | 6분 제한 + continuation 트리거 | 무제한 |
| 상태 관리 | 숨김 시트 JSON | 메모리 (불필요) |
| AI 모델 | Gemini Flash | OpenAI GPT-5.4 |
| 파일 추출 | Google export API만 (5%) | 로컬 파싱 포함 (75%+) |
| 결과 기입 | 전체 완료 후 일괄 | 청크별 즉시 기입 (실시간) |
| 매칭 모드 | ai / keyword / keyword_then_ai | 동일 3개 모드 |
| UI | Google Sheets 사이드바 | CLI + 대화형 입력 |
| 로그 | 숨김 시트 로그 | 파일 로그 (log/ 폴더, UTF-8) |
| 인증 | Google 로그인 자동 | 서비스 계정 JSON |
| 출력 컬럼 | 수동 지정 | 자동 감지/추가 |
| 패키지 관리 | 없음 | uv |

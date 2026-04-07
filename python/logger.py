"""
logger.py: 파일 로깅 설정
- log/ 폴더에 실행 단위 로그 파일 생성
- 콘솔 + 파일 동시 출력
"""

import io
import logging
import os
import sys
from datetime import datetime

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "log")


def setup_logger(name: str = "fillcontent") -> logging.Logger:
    """log/ 폴더에 타임스탬프 기반 로그 파일을 생성하고 로거를 반환한다."""
    os.makedirs(LOG_DIR, exist_ok=True)

    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_file = os.path.join(LOG_DIR, f"fillcontent_{timestamp}.log")

    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)

    # 기존 핸들러 제거 (중복 방지)
    logger.handlers.clear()

    # 파일 핸들러 — DEBUG 이상 전부 기록
    file_handler = logging.FileHandler(log_file, encoding="utf-8")
    file_handler.setLevel(logging.DEBUG)
    file_fmt = logging.Formatter(
        "%(asctime)s [%(levelname)-7s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    file_handler.setFormatter(file_fmt)

    # 콘솔 핸들러 — INFO 이상만 출력 (UTF-8 강제)
    utf8_stream = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    console_handler = logging.StreamHandler(stream=utf8_stream)
    console_handler.setLevel(logging.INFO)
    console_fmt = logging.Formatter("%(message)s")
    console_handler.setFormatter(console_fmt)

    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    logger.info(f"로그 파일: {log_file}")
    return logger

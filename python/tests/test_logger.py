"""
test_logger.py: logger 모듈 단위 테스트
"""

import os
import pytest
from logger import setup_logger, LOG_DIR


class TestLogger:
    def test_creates_log_directory(self):
        log = setup_logger("test_logger")
        assert os.path.exists(LOG_DIR)

    def test_creates_log_file(self):
        log = setup_logger("test_logger_file")
        # 파일 핸들러가 생성한 로그 파일 확인
        log_files = [f for f in os.listdir(LOG_DIR) if f.startswith("fillcontent_")]
        assert len(log_files) > 0

    def test_has_file_and_console_handlers(self):
        log = setup_logger("test_handlers")
        assert len(log.handlers) == 2  # file + console

    def test_log_levels(self):
        import logging
        log = setup_logger("test_levels")
        assert log.level == logging.DEBUG
        # 파일 핸들러는 DEBUG, 콘솔은 INFO
        file_handler = [h for h in log.handlers if hasattr(h, "baseFilename")]
        console_handler = [h for h in log.handlers if not hasattr(h, "baseFilename")]
        assert file_handler[0].level == logging.DEBUG
        assert console_handler[0].level == logging.INFO

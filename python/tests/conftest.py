"""
conftest.py: 테스트 공통 fixture
"""

import sys
import os

# python/ 디렉토리를 모듈 경로에 추가
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

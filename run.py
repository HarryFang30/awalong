#!/usr/bin/env python3
"""启动阿瓦隆练习场：python run.py（可选参数见 python run.py --help）"""
import sys

if sys.version_info < (3, 9):
    sys.exit("需要 Python 3.9 或更高版本")

from avalon.server import main

if __name__ == "__main__":
    main()

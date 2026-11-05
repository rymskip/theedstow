import ctypes
import os
import sys

suffix = "dylib" if sys.platform == "darwin" else "so"
blosc = ctypes.CDLL(os.path.join(os.environ["PREFIX"], "lib", f"libblosc.{suffix}"))
blosc.blosc_list_compressors.restype = ctypes.c_char_p

compressors = set(blosc.blosc_list_compressors().decode().split(","))
assert compressors == {"blosclz", "lz4", "lz4hc"}, compressors

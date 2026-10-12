"""Read-only native serialization inspection; dependencies: capstone, pefile.
Run: python tools/btw-native.py <hex-rva> [byte-count]
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent / 'python'))
import pefile
import capstone
target = Path(r'C:\Program Files\Seagull\BarTender 12.1\BarTend.exe')
pe = pefile.PE(str(target), fast_load=True)
rva = int(sys.argv[1], 16)
size = int(sys.argv[2]) if len(sys.argv) > 2 else 1000
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
for instruction in md.disasm(pe.get_data(rva, size), pe.OPTIONAL_HEADER.ImageBase + rva):
    print(f'{instruction.address - pe.OPTIONAL_HEADER.ImageBase:08x} {instruction.mnemonic:8} {instruction.op_str}')

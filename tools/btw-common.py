"""Read an explicitly located ObjectData record for research (not production import).
Usage: python tools/btw-common.py FILE OFFSET
OFFSET is the first byte AFTER the runtime class name, established by a researcher.
"""
import struct,sys,json
from pathlib import Path
def payload(path):
 import zlib
 data=Path(path).read_bytes();offset=data.index(b'\x1a')+25
 count=data[offset+3];offset+=4
 if count==255:count=struct.unpack_from('<H',data,offset)[0];offset+=2
 offset+=count*2+4
 for _ in range(2):count=struct.unpack_from('<I',data,offset)[0];offset+=4+count
 return zlib.decompress(data[offset+2:])
b=payload(sys.argv[1]);o=int(sys.argv[2]);fields={}
def read(name,n,fmt=None):
 global o
 v=struct.unpack_from(fmt,b,o)[0] if fmt else b[o:o+n].hex();fields[name]={'offset':o,'value':v};o+=n;return v
def i(name):return read(name,4,'<i')
def flag(name):return read(name,1,'<B')
def s(name):
 global o
 start=o;assert b[o:o+3]==b'\xff\xfe\xff',(name,o,b[o:o+8].hex());o+=3;n=b[o];o+=1
 if n==255:n=struct.unpack_from('<H',b,o)[0];o+=2
 v=b[o:o+n*2].decode('utf-16le');o+=n*2;fields[name]={'offset':start,'value':v};return v
for name in ['x','y','horizontalAlignment','verticalAlignment','orientation']:i(name)
s('editorPath');s('comment');flag('unknown600');s('unknown670');i('conditionalMode');s('conditionalScript');flag('unknown530');flag('unknown531')
i('unknown67c');i('angleMillidegrees');read('unknown684',8);i('unknown68c');flag('unknown690');flag('unknown568');s('name');read('guid',16);flag('parentPresent');read('extensionTerminator',2)
i('height');i('width');flag('pcmPresent');i('colorModel')
print(json.dumps(fields,indent=2));print('next',o,b[o:o+100].hex())

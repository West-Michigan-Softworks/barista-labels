"""Controlled profile differential analysis; NOT used at application runtime."""
from pathlib import Path
import struct,zlib,hashlib
def load(path):
 b=Path(path).read_bytes();o=b.index(b'\x1a')+25;n=b[o+3];o+=4+n*2+4
 for _ in range(2):n=struct.unpack_from('<I',b,o)[0];o+=4+n
 return bytearray(zlib.decompress(b[o+2:]))
root=Path('research-artifacts/btw');base=load(root/'mail-core.btw')
textpos=base.find('Hello world'.encode('utf-16le'))-4
print('text field',textpos,'baseline chars',base[textpos+3], 'base bytes',len(base))
for path in sorted(root.glob('mail-core*.btw')):
 d=load(path);n=d[textpos+3];del d[textpos:textpos+4+n*2];d[38:54]=bytes(16)
 ref=bytearray(base);bn=ref[textpos+3];del ref[textpos:textpos+4+bn*2];ref[38:54]=bytes(16)
 changes=[]
 for i,(a,b)in enumerate(zip(ref,d)):
  if a!=b:
   if changes and i<=changes[-1][-1]+4:changes[-1].append(i)
   else:changes.append([i])
 print(path.name,'digest',hashlib.sha256(d).hexdigest(),'changes',[(g[0],g[-1]+1,ref[g[0]:g[-1]+5].hex(),d[g[0]:g[-1]+5].hex())for g in changes])

"""Compare decompressed controlled BTW files (research only)."""
from pathlib import Path
import struct,sys,zlib
def load(path):
    data=Path(path).read_bytes();offset=data.index(b'\x1a')+25
    count=data[offset+3];offset+=4
    if count==255:count=struct.unpack_from('<H',data,offset)[0];offset+=2
    offset+=count*2+4
    for _ in range(2):count=struct.unpack_from('<I',data,offset)[0];offset+=4+count
    return zlib.decompress(data[offset+2:])
left,right=map(load,sys.argv[1:3])
print('Lengths',len(left),len(right))
ranges=[]
for index,(a,b) in enumerate(zip(left,right)):
    if a!=b:
        if ranges and index<=ranges[-1][-1]+4:ranges[-1].append(index)
        else:ranges.append([index])
for group in ranges:
    start,end=group[0],group[-1]+1
    print(start,end,left[start:end+4].hex(),right[start:end+4].hex())

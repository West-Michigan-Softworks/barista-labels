"""Local research inventory (never imports label content into a project).
Usage: python tools/btw-inspect.py [directory-or-file]
No proprietary sample files are copied. Output contains structural evidence only.
"""
from pathlib import Path
import collections, hashlib, json, re, struct, sys, zlib

def envelope(data):
    start = data.index(b'\x1a') + 1
    fields = struct.unpack_from('<6I', data, start)
    cursor = start + 24
    assert data[cursor:cursor+3] == b'\xff\xfe\xff'
    cursor += 3
    count = data[cursor]; cursor += 1
    if count == 255:
        count = struct.unpack_from('<H', data, cursor)[0]; cursor += 2
        if count == 65535:
            count = struct.unpack_from('<I', data, cursor)[0]; cursor += 4
    description = data[cursor:cursor+count*2].decode('utf-16le'); cursor += count*2
    reserved = struct.unpack_from('<I', data, cursor)[0]; cursor += 4
    previews=[]
    for _ in range(fields[1]):
        count=struct.unpack_from('<I', data, cursor)[0]; cursor+=4
        previews.append((cursor,count)); cursor+=count
    flags=data[cursor:cursor+2];cursor+=2
    assert flags==b'\x00\x01', flags.hex()
    decoder=zlib.decompressobj()
    payload=decoder.decompress(data[cursor:], 32*1024*1024)
    assert decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail
    return fields,previews,cursor,payload

target=Path(sys.argv[1]) if len(sys.argv)>1 else Path(r'C:\Program Files\Seagull\BarTender 12.1\Templates')
paths=[target] if target.is_file() else sorted(p for p in target.rglob('*') if p.suffix.lower()=='.btw')
records=[]
for path in paths:
    data=path.read_bytes()
    try:
        fields,previews,start,payload=envelope(data)
        classes=[{'offset':m.start(),'name':m.group().decode('ascii')} for m in re.finditer(rb'[A-Za-z][A-Za-z0-9_]{2,50}Data\b',payload)]
        records.append({'file':str(path),'sha256':hashlib.sha256(data).hexdigest(),'fields':fields,'previews':previews,'zlibOffset':start,'inflatedBytes':len(payload),'classes':classes})
        if target.is_file():
            print('payload first bytes',payload[:700].hex(),file=sys.stderr)
            for item in classes[:25]:
                pos=item['offset'];print(item, payload[max(0,pos-8):pos+160].hex(),file=sys.stderr)
    except Exception as exc:records.append({'file':str(path),'error':str(exc)})
print(json.dumps({'counts':dict(collections.Counter(str(r.get('fields',[None])[0]) for r in records)),'records':records},indent=2))

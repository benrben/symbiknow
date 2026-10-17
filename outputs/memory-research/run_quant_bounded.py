"""Repeat multimodal probes with an explicit 128 MiB MLX cache budget."""
import os
from pathlib import Path
import subprocess
import sys

base=Path(__file__).resolve().parent
for mode in ['mlx-8','mlx-4']:
    name=f'{mode}-vision-cache128'
    print('Starting',name,flush=True)
    with (base/'quantization'/f'{name}.log').open('w') as log:
        result=subprocess.run([sys.executable,str(base/'quant_bench.py'),'run',mode,'vision'],env={**os.environ,'QUANT_CACHE_LIMIT_MIB':'128'},stdout=log,stderr=subprocess.STDOUT,timeout=300)
    print('Finished',name,'exit',result.returncode,flush=True)
    if result.returncode:
        print((base/'quantization'/f'{name}.log').read_text()[-5000:],flush=True)
        sys.exit(result.returncode)

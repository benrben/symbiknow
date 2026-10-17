"""Run independent benchmark processes sequentially to avoid GPU contention."""
import subprocess
import sys
from pathlib import Path

base=Path(__file__).resolve().parent
for mode,modality in [
    ('pt-fp32','vision'),('pt-bf16','vision'),('mlx-bf16','vision'),
    ('mlx-4','vision'),('mlx-bf16','text'),('mlx-8','text'),('mlx-4','text'),
]:
    name=f'{mode}-{modality}'
    print('Starting',name,flush=True)
    with (base/'quantization'/f'{name}.log').open('w') as log:
        result=subprocess.run([sys.executable,str(base/'quant_bench.py'),'run',mode,modality],stdout=log,stderr=subprocess.STDOUT,timeout=300)
    print('Finished',name,'exit',result.returncode,flush=True)
    if result.returncode:
        print((base/'quantization'/f'{name}.log').read_text()[-5000:],flush=True)
        sys.exit(result.returncode)

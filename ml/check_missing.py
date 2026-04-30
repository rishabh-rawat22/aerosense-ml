import pandas as pd
from pathlib import Path

df = pd.read_csv('../data/stations_info.csv')
cities = sorted(df['city'].str.strip().unique().tolist())

c_dir = Path('models/checkpoints')
missing = []
for c in cities:
    safe = c.lower().replace(" ", "_")
    if not (c_dir / f"lstm_{safe}_latest.pt").exists():
        missing.append(c)

print(f"Total cities: {len(cities)}")
print(f"Missing {len(missing)} cities: {missing}")

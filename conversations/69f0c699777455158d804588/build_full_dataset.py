import json, os

# 1. Drivers
with open("drivers.json") as f:
    drivers = json.load(f)

print(f"Loaded {len(drivers)} drivers")

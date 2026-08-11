import json

# Cycling locations
cycling = [
    {
        "id": "6a5029df4064a88dbd1844d8",
        "name": "Londonderry Flo",
        "latitude": 53.6041356,
        "longitude": -113.4453285,
        "city_id": "6858ef85659a1fbb068efa5f",
        "usage_count": 16.0,
        "created_by_app_user_id": "68dfe2ef6c16bedca49a41b9",
        "created_date": "2026-07-09T23:08:15.339000",
        "updated_date": "2026-08-07T22:00:45.727000",
        "created_by_id": "68570f3cd01bfa2d2408a9d7",
        "created_by": "tauberr1328@gmail.com"
    },
    {
        "id": "6a4bee0a2de40f189eab9c20",
        "name": "Callingwood Flo",
        "latitude": 53.5058511,
        "longitude": -113.6277473,
        "city_id": "6858ef85659a1fbb068efa5f",
        "usage_count": 28.0,
        "created_by_app_user_id": "68dfe2ef6c16bedca49a41b9",
        "created_date": "2026-07-06T18:03:54.153000",
        "updated_date": "2026-08-10T17:36:14.728000",
        "created_by_id": "68570f3cd01bfa2d2408a9d7",
        "created_by": "tauberr1328@gmail.com",
        "app_delete_op_id": None
    },
    {
        "id": "6a483185a0dcecde5511d9c7",
        "name": "Manning AMA",
        "latitude": 53.6016701,
        "longitude": -113.4193333,
        "city_id": "6858ef85659a1fbb068efa5f",
        "usage_count": 16.0,
        "created_by_app_user_id": "68dfe2ef6c16bedca49a41b9",
        "created_date": "2026-07-03T22:02:45.940000",
        "updated_date": "2026-07-20T21:24:49.587000",
        "created_by_id": "68570f3cd01bfa2d2408a9d7",
        "created_by": "tauberr1328@gmail.com"
    }
]

with open("cycling.json", "w") as f:
    json.dump(cycling, f, indent=2)

print("cycling.json written")

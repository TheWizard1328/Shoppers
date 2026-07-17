import os

with open('src/pages/DriverSettings.jsx', 'r') as f:
    text = f.read()

# Replace the imports and state:
old_lucide = "import { Truck, Search, Phone, MapPin, User, Circle, RefreshCw, Edit, Navigation, Building2 } from 'lucide-react';"
new_lucide = "import { Truck, Search, Phone, MapPin, User, Circle, RefreshCw, Edit, Navigation, Building2, FileText, ShieldCheck } from 'lucide-react';"

old_edit_form = "import DriverEditForm from '../components/drivers/DriverEditForm';"
new_edit_form = "import DriverEditForm from '../components/drivers/DriverEditForm';\nimport DriverDetailSheet from '../components/drivers/DriverDetailSheet';"

old_state = "const [editingDriver, setEditingDriver] = useState(null);"
new_state = "const [editingDriver, setEditingDriver] = useState(null);\n  const [selectedDriver, setSelectedDriver] = useState(null);"

text = text.replace(old_lucide, new_lucide)
text = text.replace(old_edit_form, new_edit_form)
text = text.replace(old_state, new_state)

# Replace the non-admin card branch:
target_old_card = """              if (!isAdmin) {
                // Compact card for drivers/dispatchers
                const cardContent =
                <CardContent className="p-3">
                    <div className="flex items-center gap-3">
                      {/* Avatar */}
                      <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${avatarColor}`}>
                        <span className="text-white font-bold text-sm">
                          {(getDriverDisplayName(driver) || 'D')?.charAt(0).toUpperCase()}
                        </span>
                      </div>
                      {/* Info */}
                      <div className="flex-1 min-w-0">
                       <div className="flex items-center justify-between gap-2">
                         <p className="font-semibold text-sm truncate" style={{ color: 'var(--text-slate-900)' }}>
                           {getDriverDisplayName(driver)}
                         </p>
                         {distToStore &&
                        <Badge className={`text-xs py-0 h-4 gap-0.5 flex-shrink-0 ${distBadgeClass}`}>
                          <MapPin className="w-2.5 h-2.5" />
                          {distToStore}
                        </Badge>
                        }
                       </div>
                       <div className="flex items-center gap-1 flex-wrap mt-0.5">
                         <Badge className={`text-xs py-0 h-4 ${dutyStatus.color}`}>{dutyStatus.label}</Badge>
                         {gpsLabel &&
                        <Badge className={`text-xs py-0 h-4 gap-0.5 ${gpsLabel.isRecent ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}`}>
                             <Navigation className="w-2.5 h-2.5" />
                             {gpsLabel.label}
                           </Badge>
                        }
                       </div>
                        {driver.phone &&
                      <div className="flex items-center gap-1 mt-1 text-xs" style={{ color: 'var(--text-slate-500)' }}>
                            <Phone className="w-3 h-3" />
                            {formatPhoneNumber(driver.phone)}
                          </div>
                      }
                      </div>
                    </div>
                  </CardContent>;

                return driver.phone ?
                <a key={driver.id} href={`tel:${driver.phone}`} className="block">
                    <Card className="rounded-xl border shadow hover:shadow-md transition-shadow active:opacity-70" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                      {cardContent}
                    </Card>
                  </a> :

                <Card key={driver.id} className="rounded-xl border shadow hover:shadow-md transition-shadow" style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}>
                    {cardContent}
                  </Card>;

              }"""

new_card_content = """              if (!isAdmin) {
                // Compact card for drivers/dispatchers with 3-row layout and bottom sheet click handler
                return (
                  <Card 
                    key={driver.id} 
                    onClick={() => setSelectedDriver(driver)}
                    className="rounded-xl border shadow hover:shadow-md transition-shadow cursor-pointer active:opacity-70" 
                    style={{ background: 'var(--bg-white)', borderColor: 'var(--border-slate-200)' }}
                  >
                    <CardContent className="p-3">
                      <div className="flex flex-col gap-2">
                        {/* Row 1: Avatar + Name + Distance badge */}
                        <div className="flex items-center justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0 flex-1">
                            {/* Avatar */}
                            <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${avatarColor}`}>
                              <span className="text-white font-bold text-sm">
                                {(getDriverDisplayName(driver) || 'D')?.charAt(0).toUpperCase()}
                              </span>
                            </div>
                            {/* Name */}
                            <p className="font-semibold text-sm truncate" style={{ color: 'var(--text-slate-900)' }}>
                              {getDriverDisplayName(driver)}
                            </p>
                          </div>
                          {distToStore && (
                            <Badge className={`text-xs py-0 h-4 gap-0.5 flex-shrink-0 ${distBadgeClass}`}>
                              <MapPin className="w-2.5 h-2.5" />
                              {distToStore}
                            </Badge>
                          )}
                        </div>

                        {/* Row 2: Duty status badge + GPS badge + Phone number (non-tappable display only) */}
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-1 flex-wrap">
                            <Badge className={`text-xs py-0 h-4 ${dutyStatus.color}`}>{dutyStatus.label}</Badge>
                            {gpsLabel && (
                              <Badge className={`text-xs py-0 h-4 gap-0.5 ${gpsLabel.isRecent ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-700'}`}>
                                <Navigation className="w-2.5 h-2.5" />
                                {gpsLabel.label}
                              </Badge>
                            )}
                          </div>
                          {driver.phone && (
                            <div className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-slate-500)' }}>
                              <Phone className="w-3 h-3" />
                              {formatPhoneNumber(driver.phone)}
                            </div>
                          )}
                        </div>

                        {/* Row 3: Blank row for document management button/status */}
                        <div className="flex items-center justify-start pt-1 border-t border-slate-100/50">
                          {currentUser?.app_roles?.includes('dispatcher') ? (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={(e) => {
                                e.stopPropagation(); // Avoid triggering card-level onClick to open sheet
                                console.log('Request docs for', driver.id);
                              }}
                              className="h-6 px-2 text-[10px] rounded-full flex items-center gap-1 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200"
                            >
                              <FileText className="w-2.5 h-2.5" />
                              Request Docs
                            </Button>
                          ) : (
                            <div className="h-6" /> // Placeholder spacing
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              }"""

# Replace the non-admin card branch
text = text.replace(target_old_card, new_card_content)

# Add DriverDetailSheet rendering right before the closing </div>
old_closing = """      })()
      }
    </div>);

}"""

new_closing = """      })()
      }
      {selectedDriver && (
        <DriverDetailSheet
          driver={selectedDriver}
          currentUser={currentUser}
          onClose={() => setSelectedDriver(null)}
        />
      )}
    </div>);

}"""

text = text.replace(old_closing, new_closing)

with open('src/pages/DriverSettings.jsx', 'w') as f:
    f.write(text)

print("Replacement complete and file written!")

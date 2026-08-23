# rethink entity id rename map

Applied in the early hours of 23 August 2026 (KST). To undo it, swap the two columns and
apply them again with `ha_set_entity(new_entity_id=...)`.

Changes made alongside it:

- 38 references across 27 entities in the dashboard (`.storage/lovelace.lovelace`) were
  updated from the same table. Automations, scripts and the energy dashboard reference no
  rethink entities and were left alone.
- `core.config_entries` was checked exhaustively. An entity_id that a helper such as Min/Max
  or Threshold holds inside its config entry is not updated by a registry rename, but **none**
  of them referenced a rethink entity.
- Areas were assigned to rethink's eleven devices. The values came from the existing
  `smartthinq_sensors_custom` devices; only the kimchi refrigerator has no device there, so it
  took the value from `lg_thinq` (`jubang`).

The first column keeps the Korean device names: they are what Home Assistant calls these
appliances, and the entity ids romanise them, so translating the column would break the
correspondence the table exists to record.

| Appliance    | Was                                                         | Now                                                       |
| ------------ | ----------------------------------------------------------- | --------------------------------------------------------- |
| 거실에어컨   | `binary_sensor.geosileeokeon_siloegi_abcuggi`               | `binary_sensor.rethink_geosileeokeon_outdoor_compressor`  |
| 거실에어컨   | `climate.lg_air_conditioner_2`                              | `climate.rethink_geosileeokeon`                           |
| 거실에어컨   | `number.lg_air_conditioner_sleep_timer_2`                   | `number.rethink_geosileeokeon_sleeptimer`                 |
| 거실에어컨   | `number.lg_air_conditioner_turn_on_timer_2`                 | `number.rethink_geosileeokeon_starttimer`                 |
| 거실에어컨   | `number.lg_air_conditioner_turn_off_timer_2`                | `number.rethink_geosileeokeon_stoptimer`                  |
| 거실에어컨   | `select.lg_air_conditioner_humidity_sensor_mode`            | `select.rethink_geosileeokeon_humidity_sensor_mode`       |
| 거실에어컨   | `sensor.lg_air_conditioner_auto_dry_progress`               | `sensor.rethink_geosileeokeon_autodryprogress`            |
| 거실에어컨   | `sensor.lg_air_conditioner_power_2`                         | `sensor.rethink_geosileeokeon_energy_current`             |
| 거실에어컨   | `sensor.lg_air_conditioner_error_code_2`                    | `sensor.rethink_geosileeokeon_error`                      |
| 거실에어컨   | `sensor.lg_air_conditioner_filter_remaining_life`           | `sensor.rethink_geosileeokeon_filterremaining`            |
| 거실에어컨   | `sensor.lg_air_conditioner_humidity`                        | `sensor.rethink_geosileeokeon_humidity`                   |
| 거실에어컨   | `sensor.geosileeokeon_siloegi_nujeog_jeonryeog_sayongryang` | `sensor.rethink_geosileeokeon_outdoor_energy_total`       |
| 거실에어컨   | `sensor.geosileeokeon_siloegi_sobi_jeonryeog`               | `sensor.rethink_geosileeokeon_outdoor_power`              |
| 거실에어컨   | `sensor.lg_air_conditioner_pm1_0`                           | `sensor.rethink_geosileeokeon_pm1`                        |
| 거실에어컨   | `sensor.lg_air_conditioner_pm10`                            | `sensor.rethink_geosileeokeon_pm10`                       |
| 거실에어컨   | `sensor.lg_air_conditioner_pm2_5`                           | `sensor.rethink_geosileeokeon_pm25`                       |
| 거실에어컨   | `sensor.lg_air_conditioner_sleep_time`                      | `sensor.rethink_geosileeokeon_sleep_time`                 |
| 거실에어컨   | `sensor.geosileeokeon_sijag_sigan`                          | `sensor.rethink_geosileeokeon_start_time`                 |
| 거실에어컨   | `sensor.lg_air_conditioner_stop_time`                       | `sensor.rethink_geosileeokeon_stop_time`                  |
| 거실에어컨   | `switch.lg_air_conditioner_gonggiceongjeong`                | `switch.rethink_geosileeokeon_airclean`                   |
| 거실에어컨   | `switch.lg_air_conditioner_auto_dry`                        | `switch.rethink_geosileeokeon_autodry`                    |
| 거실에어컨   | `switch.lg_air_conditioner_aiseukulpaweo`                   | `switch.rethink_geosileeokeon_coolpower`                  |
| 거실에어컨   | `switch.lg_air_conditioner_display_light`                   | `switch.rethink_geosileeokeon_displaylight`               |
| 거실에어컨   | `switch.lg_air_conditioner_energy_saving_2`                 | `switch.rethink_geosileeokeon_energysave`                 |
| 거실에어컨   | `switch.lg_air_conditioner_aiseurongpaweo`                  | `switch.rethink_geosileeokeon_longpower`                  |
| 거실에어컨   | `switch.lg_air_conditioner_smart_care`                      | `switch.rethink_geosileeokeon_smartcare`                  |
| 거실제습기   | `binary_sensor.geosiljeseubgi_multong_gadeug_cam`           | `binary_sensor.rethink_geosiljeseubgi_water_tank_full`    |
| 거실제습기   | `humidifier.lg_dehumidifier`                                | `humidifier.rethink_geosiljeseubgi`                       |
| 거실제습기   | `number.geosiljeseubgi_ggeojim_yeyag`                       | `number.rethink_geosiljeseubgi_off_timer`                 |
| 거실제습기   | `number.geosiljeseubgi_mogpyo_seubdo`                       | `number.rethink_geosiljeseubgi_target_humidity`           |
| 거실제습기   | `select.geosiljeseubgi_baram_segi`                          | `select.rethink_geosiljeseubgi_fan_speed`                 |
| 거실제습기   | `select.geosiljeseubgi_seubdo_senseo`                       | `select.rethink_geosiljeseubgi_humidity_sensor`           |
| 거실제습기   | `sensor.lg_dehumidifier_error`                              | `sensor.rethink_geosiljeseubgi_error`                     |
| 거실제습기   | `sensor.geosiljeseubgi_jongryo_sigan`                       | `sensor.rethink_geosiljeseubgi_off_time`                  |
| 거실제습기   | `sensor.lg_dehumidifier_temperature`                        | `sensor.rethink_geosiljeseubgi_temperature`               |
| 거실제습기   | `switch.geosiljeseubgi_jepum_beoteuneum`                    | `switch.rethink_geosiljeseubgi_button_sound`              |
| 거실제습기   | `switch.geosiljeseubgi_jepum_sangtae_pyosibu`               | `switch.rethink_geosiljeseubgi_status_display`            |
| 거실제습기   | `switch.geosiljeseubgi_uvnano`                              | `switch.rethink_geosiljeseubgi_uvnano`                    |
| 거실제습기   | `switch.geosiljeseubgi_multong_jomyeong`                    | `switch.rethink_geosiljeseubgi_water_tank_light`          |
| 건조기       | `binary_sensor.lg_dryer_anti_crease`                        | `binary_sensor.rethink_geonjogi_anti_crease`              |
| 건조기       | `binary_sensor.lg_dryer_power`                              | `binary_sensor.rethink_geonjogi_power`                    |
| 건조기       | `binary_sensor.lg_dryer_unjeon_wanryo`                      | `binary_sensor.rethink_geonjogi_run_completed`            |
| 건조기       | `sensor.lg_dryer_course`                                    | `sensor.rethink_geonjogi_course`                          |
| 건조기       | `sensor.lg_dryer_downloaded_course`                         | `sensor.rethink_geonjogi_downloaded_course`               |
| 건조기       | `sensor.lg_dryer_dry_level`                                 | `sensor.rethink_geonjogi_dry_level`                       |
| 건조기       | `sensor.lg_dryer_eco_hybrid`                                | `sensor.rethink_geonjogi_eco_hybrid`                      |
| 건조기       | `sensor.lg_dryer_initial_time`                              | `sensor.rethink_geonjogi_initial_time`                    |
| 건조기       | `sensor.lg_dryer_process_status`                            | `sensor.rethink_geonjogi_process_status`                  |
| 건조기       | `sensor.lg_dryer_remaining_time`                            | `sensor.rethink_geonjogi_remaining_time`                  |
| 건조기       | `sensor.lg_dryer_reserve_time`                              | `sensor.rethink_geonjogi_reserve_time`                    |
| 건조기       | `sensor.lg_dryer_status`                                    | `sensor.rethink_geonjogi_status`                          |
| 김치냉장고   | `binary_sensor.lg_kimchi_refrigerator_display_lock`         | `binary_sensor.rethink_gimcinaengjanggo_display_lock`     |
| 김치냉장고   | `binary_sensor.lg_kimchi_refrigerator_door`                 | `binary_sensor.rethink_gimcinaengjanggo_door`             |
| 김치냉장고   | `binary_sensor.lg_kimchi_refrigerator_one_touch_filter`     | `binary_sensor.rethink_gimcinaengjanggo_one_touch_filter` |
| 김치냉장고   | `sensor.gimcinaengjanggo_bottom_room`                       | `sensor.rethink_gimcinaengjanggo_bottom_room_mode`        |
| 김치냉장고   | `sensor.lg_kimchi_refrigerator_bottom_room_temperature`     | `sensor.rethink_gimcinaengjanggo_bottom_room_temperature` |
| 김치냉장고   | `sensor.gimcinaengjanggo_middle_room`                       | `sensor.rethink_gimcinaengjanggo_middle_room_mode`        |
| 김치냉장고   | `sensor.lg_kimchi_refrigerator_middle_room_temperature`     | `sensor.rethink_gimcinaengjanggo_middle_room_temperature` |
| 김치냉장고   | `sensor.lg_kimchi_refrigerator_monitor_status`              | `sensor.rethink_gimcinaengjanggo_monitor_status`          |
| 김치냉장고   | `sensor.gimcinaengjanggo_top_room`                          | `sensor.rethink_gimcinaengjanggo_top_room_mode`           |
| 김치냉장고   | `sensor.lg_kimchi_refrigerator_top_room_temperature`        | `sensor.rethink_gimcinaengjanggo_top_room_temperature`    |
| 냉장고       | `binary_sensor.lg_fridge_control_panel_lock`                | `binary_sensor.rethink_naengjanggo_control_panel_lock`    |
| 냉장고       | `binary_sensor.lg_fridge_door`                              | `binary_sensor.rethink_naengjanggo_door`                  |
| 냉장고       | `binary_sensor.lg_fridge_freezer_door`                      | `binary_sensor.rethink_naengjanggo_freezer_door`          |
| 냉장고       | `binary_sensor.lg_fridge_fridge_door`                       | `binary_sensor.rethink_naengjanggo_fridge_door`           |
| 냉장고       | `number.lg_fridge_freezer_temperature`                      | `number.rethink_naengjanggo_freezer_setpoint`             |
| 냉장고       | `number.lg_fridge_fridge_temperature`                       | `number.rethink_naengjanggo_fridge_setpoint`              |
| 냉장고       | `switch.lg_fridge_express_freeze`                           | `switch.rethink_naengjanggo_express_freeze`               |
| 미니워시     | `binary_sensor.lg_mini_washer_door_lock`                    | `binary_sensor.rethink_miniweosi_door_lock`               |
| 미니워시     | `binary_sensor.lg_mini_washer_error`                        | `binary_sensor.rethink_miniweosi_error`                   |
| 미니워시     | `binary_sensor.lg_mini_washer_power`                        | `binary_sensor.rethink_miniweosi_power`                   |
| 미니워시     | `binary_sensor.lg_mini_washer_unjeon_wanryo`                | `binary_sensor.rethink_miniweosi_run_completed`           |
| 미니워시     | `sensor.lg_mini_washer_error_message`                       | `sensor.rethink_miniweosi_error_message`                  |
| 미니워시     | `sensor.lg_mini_washer_initial_time`                        | `sensor.rethink_miniweosi_initial_time`                   |
| 미니워시     | `sensor.lg_mini_washer_previous_status`                     | `sensor.rethink_miniweosi_previous_status`                |
| 미니워시     | `sensor.lg_mini_washer_remaining_time`                      | `sensor.rethink_miniweosi_remaining_time`                 |
| 미니워시     | `sensor.lg_mini_washer_reserve_time`                        | `sensor.rethink_miniweosi_reserve_time`                   |
| 미니워시     | `sensor.lg_mini_washer_status`                              | `sensor.rethink_miniweosi_status`                         |
| 세탁기       | `binary_sensor.lg_washer_power`                             | `binary_sensor.rethink_setaggi_power`                     |
| 세탁기       | `binary_sensor.lg_washer_unjeon_wanryo`                     | `binary_sensor.rethink_setaggi_run_completed`             |
| 세탁기       | `sensor.lg_washer_course`                                   | `sensor.rethink_setaggi_course`                           |
| 세탁기       | `sensor.lg_washer_downloaded_course`                        | `sensor.rethink_setaggi_downloaded_course`                |
| 세탁기       | `sensor.lg_washer_dry_level`                                | `sensor.rethink_setaggi_dry_level`                        |
| 세탁기       | `sensor.lg_washer_initial_time`                             | `sensor.rethink_setaggi_initial_time`                     |
| 세탁기       | `sensor.lg_washer_operation_course`                         | `sensor.rethink_setaggi_operation_course`                 |
| 세탁기       | `sensor.lg_washer_previous_status`                          | `sensor.rethink_setaggi_previous_status`                  |
| 세탁기       | `sensor.lg_washer_remaining_time`                           | `sensor.rethink_setaggi_remaining_time`                   |
| 세탁기       | `sensor.lg_washer_reserve_time`                             | `sensor.rethink_setaggi_reserve_time`                     |
| 세탁기       | `sensor.lg_washer_rinse`                                    | `sensor.rethink_setaggi_rinse`                            |
| 세탁기       | `sensor.lg_washer_soil`                                     | `sensor.rethink_setaggi_soil`                             |
| 세탁기       | `sensor.lg_washer_spin`                                     | `sensor.rethink_setaggi_spin`                             |
| 세탁기       | `sensor.lg_washer_status`                                   | `sensor.rethink_setaggi_status`                           |
| 세탁기       | `sensor.lg_washer_tub_clean_count`                          | `sensor.rethink_setaggi_tub_clean_count`                  |
| 세탁기       | `sensor.lg_washer_water_temp`                               | `sensor.rethink_setaggi_water_temp`                       |
| 식기세척기   | `binary_sensor.lg_dishwasher_power`                         | `binary_sensor.rethink_siggiseceoggi_power`               |
| 식기세척기   | `binary_sensor.lg_dishwasher_unjeon_wanryo`                 | `binary_sensor.rethink_siggiseceoggi_run_completed`       |
| 식기세척기   | `sensor.lg_dishwasher_course`                               | `sensor.rethink_siggiseceoggi_course`                     |
| 식기세척기   | `sensor.lg_dishwasher_current_download_course`              | `sensor.rethink_siggiseceoggi_current_download_course`    |
| 식기세척기   | `sensor.lg_dishwasher_initial_time`                         | `sensor.rethink_siggiseceoggi_initial_time`               |
| 식기세척기   | `sensor.lg_dishwasher_process`                              | `sensor.rethink_siggiseceoggi_process`                    |
| 식기세척기   | `sensor.lg_dishwasher_remaining_time`                       | `sensor.rethink_siggiseceoggi_remaining_time`             |
| 식기세척기   | `sensor.lg_dishwasher_reserve_time`                         | `sensor.rethink_siggiseceoggi_reserve_time`               |
| 식기세척기   | `sensor.lg_dishwasher_status`                               | `sensor.rethink_siggiseceoggi_status`                     |
| 식기세척기   | `sensor.siggiseceoggi_tongsalgyun_hu_unjeon_hoessu`         | `sensor.rethink_siggiseceoggi_tub_clean_count`            |
| 안방에어컨   | `button.lg_air_conditioner_reset_filter_usage`              | `button.rethink_anbangeeokeon_filterreset`                |
| 안방에어컨   | `climate.lg_air_conditioner`                                | `climate.rethink_anbangeeokeon`                           |
| 안방에어컨   | `number.lg_air_conditioner_sleep_timer`                     | `number.rethink_anbangeeokeon_sleeptimer`                 |
| 안방에어컨   | `number.lg_air_conditioner_turn_on_timer`                   | `number.rethink_anbangeeokeon_starttimer`                 |
| 안방에어컨   | `number.lg_air_conditioner_turn_off_timer`                  | `number.rethink_anbangeeokeon_stoptimer`                  |
| 안방에어컨   | `sensor.lg_air_conditioner_auto_dry_remaining`              | `sensor.rethink_anbangeeokeon_autodryremain`              |
| 안방에어컨   | `sensor.lg_air_conditioner_capacity_nominal`                | `sensor.rethink_anbangeeokeon_capacity`                   |
| 안방에어컨   | `sensor.lg_air_conditioner_filter_usage_last_reset`         | `sensor.rethink_anbangeeokeon_changeddate`                |
| 안방에어컨   | `sensor.lg_air_conditioner_eev_opening`                     | `sensor.rethink_anbangeeokeon_eev`                        |
| 안방에어컨   | `sensor.lg_air_conditioner_power`                           | `sensor.rethink_anbangeeokeon_energy_current`             |
| 안방에어컨   | `sensor.lg_air_conditioner_error_code`                      | `sensor.rethink_anbangeeokeon_error`                      |
| 안방에어컨   | `sensor.lg_air_conditioner_fan_rpm`                         | `sensor.rethink_anbangeeokeon_fanrpm`                     |
| 안방에어컨   | `sensor.lg_air_conditioner_filter_life_time`                | `sensor.rethink_anbangeeokeon_filterlife`                 |
| 안방에어컨   | `sensor.lg_air_conditioner_pilteo_janryang_2`               | `sensor.rethink_anbangeeokeon_filterremaining`            |
| 안방에어컨   | `sensor.lg_air_conditioner_filter_used_time`                | `sensor.rethink_anbangeeokeon_filterused`                 |
| 안방에어컨   | `sensor.lg_air_conditioner_odu_air_temperature`             | `sensor.rethink_anbangeeokeon_oduairtemp`                 |
| 안방에어컨   | `sensor.lg_air_conditioner_odu_hex_temperature`             | `sensor.rethink_anbangeeokeon_oduhextemp`                 |
| 안방에어컨   | `sensor.lg_air_conditioner_pipe_liquid_temperature`         | `sensor.rethink_anbangeeokeon_pipeintemp`                 |
| 안방에어컨   | `sensor.lg_air_conditioner_pipe_gas_temperature`            | `sensor.rethink_anbangeeokeon_pipeouttemp`                |
| 안방에어컨   | `sensor.lg_air_conditioner_pm1_0_2`                         | `sensor.rethink_anbangeeokeon_pm1`                        |
| 안방에어컨   | `sensor.lg_air_conditioner_pm10_2`                          | `sensor.rethink_anbangeeokeon_pm10`                       |
| 안방에어컨   | `sensor.lg_air_conditioner_pm2_5_2`                         | `sensor.rethink_anbangeeokeon_pm25`                       |
| 안방에어컨   | `sensor.anbangeeokeon_cwicim_sigan`                         | `sensor.rethink_anbangeeokeon_sleep_time`                 |
| 안방에어컨   | `sensor.anbangeeokeon_sijag_sigan`                          | `sensor.rethink_anbangeeokeon_start_time`                 |
| 안방에어컨   | `sensor.anbangeeokeon_jongryo_sigan`                        | `sensor.rethink_anbangeeokeon_stop_time`                  |
| 안방에어컨   | `switch.lg_air_conditioner_air_purify`                      | `switch.rethink_anbangeeokeon_airclean`                   |
| 안방에어컨   | `switch.anbangeeokeon_jadonggeonjo_2`                       | `switch.rethink_anbangeeokeon_autodry`                    |
| 안방에어컨   | `switch.anbangeeokeon_jepum_hwamyeon`                       | `switch.rethink_anbangeeokeon_display`                    |
| 안방에어컨   | `switch.lg_air_conditioner_energy_saving`                   | `switch.rethink_anbangeeokeon_energysave`                 |
| 안방에어컨   | `switch.lg_air_conditioner_jet_cool`                        | `switch.rethink_anbangeeokeon_jet`                        |
| 작은방에어컨 | `binary_sensor.jageunbangeeokeon_abcuggi`                   | `binary_sensor.rethink_jageunbangeeokeon_compressor`      |
| 작은방에어컨 | `button.lg_air_conditioner_pilteo_sayongryang_cogihwa`      | `button.rethink_jageunbangeeokeon_filterreset`            |
| 작은방에어컨 | `climate.lg_air_conditioner_3`                              | `climate.rethink_jageunbangeeokeon`                       |
| 작은방에어컨 | `number.jageunbangeeokeon_cwicim_yeyag`                     | `number.rethink_jageunbangeeokeon_sleeptimer`             |
| 작은방에어컨 | `number.lg_air_conditioner_kyeojim_yeyag`                   | `number.rethink_jageunbangeeokeon_starttimer`             |
| 작은방에어컨 | `number.lg_air_conditioner_ggeojim_yeyag`                   | `number.rethink_jageunbangeeokeon_stoptimer`              |
| 작은방에어컨 | `select.jageunbangeeokeon_ondo_danwi`                       | `select.rethink_jageunbangeeokeon_temperature_step`       |
| 작은방에어컨 | `sensor.lg_air_conditioner_jeonggyeog_yongryang`            | `sensor.rethink_jageunbangeeokeon_capacity`               |
| 작은방에어컨 | `sensor.lg_air_conditioner_pilteo_cogihwa_naljja`           | `sensor.rethink_jageunbangeeokeon_changeddate`            |
| 작은방에어컨 | `sensor.lg_air_conditioner_jeonjapaengcangbaelbeu_gaedo`    | `sensor.rethink_jageunbangeeokeon_eev`                    |
| 작은방에어컨 | `sensor.lg_air_conditioner_jeonweon`                        | `sensor.rethink_jageunbangeeokeon_energy_current`         |
| 작은방에어컨 | `sensor.jageunbangeeokeon_nujeog_jeonryeog_sayongryang`     | `sensor.rethink_jageunbangeeokeon_energy_total`           |
| 작은방에어컨 | `sensor.lg_air_conditioner_oryu_kodeu`                      | `sensor.rethink_jageunbangeeokeon_error`                  |
| 작은방에어컨 | `sensor.lg_air_conditioner_pilteo_sumyeong`                 | `sensor.rethink_jageunbangeeokeon_filterlife`             |
| 작은방에어컨 | `sensor.lg_air_conditioner_pilteo_janryang`                 | `sensor.rethink_jageunbangeeokeon_filterremaining`        |
| 작은방에어컨 | `sensor.lg_air_conditioner_pilteo_sayong_sigan`             | `sensor.rethink_jageunbangeeokeon_filterused`             |
| 작은방에어컨 | `sensor.lg_air_conditioner_siloegi_heubib_ondo`             | `sensor.rethink_jageunbangeeokeon_oduairtemp`             |
| 작은방에어컨 | `sensor.lg_air_conditioner_siloegi_yeolgyohwangi_ondo`      | `sensor.rethink_jageunbangeeokeon_oduhextemp`             |
| 작은방에어컨 | `sensor.jageunbangeeokeon_cwicim_sigan`                     | `sensor.rethink_jageunbangeeokeon_sleep_time`             |
| 작은방에어컨 | `sensor.jageunbangeeokeon_sijag_sigan`                      | `sensor.rethink_jageunbangeeokeon_start_time`             |
| 작은방에어컨 | `sensor.jageunbangeeokeon_jongryo_sigan`                    | `sensor.rethink_jageunbangeeokeon_stop_time`              |
| 작은방에어컨 | `switch.jageunbangeeokeon_jepum_hwamyeon`                   | `switch.rethink_jageunbangeeokeon_display`                |
| 작은방에어컨 | `switch.lg_air_conditioner_jeoljeon`                        | `switch.rethink_jageunbangeeokeon_energysave`             |
| 작은방에어컨 | `switch.lg_air_conditioner_jet_cool_2`                      | `switch.rethink_jageunbangeeokeon_jet`                    |
| 작은방에어컨 | `switch.jageunbangeeokeon_jepum_sori`                       | `switch.rethink_jageunbangeeokeon_sound`                  |
| 작은방제습기 | `humidifier.jageunbangjeseubgi`                             | `humidifier.rethink_jageunbangjeseubgi`                   |
| 작은방제습기 | `number.jageunbangjeseubgi_ggeojim_yeyag`                   | `number.rethink_jageunbangjeseubgi_off_timer`             |
| 작은방제습기 | `number.jageunbangjeseubgi_mogpyo_seubdo`                   | `number.rethink_jageunbangjeseubgi_target_humidity`       |
| 작은방제습기 | `select.jageunbangjeseubgi_baram_segi`                      | `select.rethink_jageunbangjeseubgi_fan_speed`             |
| 작은방제습기 | `select.jageunbangjeseubgi_seubdo_senseo_modeu`             | `select.rethink_jageunbangjeseubgi_sensor_mode`           |
| 작은방제습기 | `sensor.jageunbangjeseubgi_oryu`                            | `sensor.rethink_jageunbangjeseubgi_error`                 |
| 작은방제습기 | `sensor.jageunbangjeseubgi_jongryo_sigan`                   | `sensor.rethink_jageunbangjeseubgi_off_time`              |
| 작은방제습기 | `switch.jageunbangjeseubgi_ceongjeong_geonjo`               | `switch.rethink_jageunbangjeseubgi_clean_dry`             |
| 작은방제습기 | `switch.jageunbangjeseubgi_multong_jomyeong`                | `switch.rethink_jageunbangjeseubgi_water_tank_light`      |

# Unificación y ampliación de BI

**Fecha:** 2026-10-31. **Estado:** fase 1 aprobada; fase 2 aprobada; fase 3 [Actual] implementada y verificada localmente, pendiente de revisión/ACK; fases 4–5 pendientes de ACK.

**Autorización inicial:** el usuario solicitó «PLEASE IMPLEMENT THIS PLAN» y reprodujo el plan completo, incluyendo ejecución por fases y ACK del repositorio. Autoriza la fase 1; no agrupar fases ni interpretar esto como autorización de DDL persistente, modificación directa del schema, infraestructura o despliegue.

## Contexto y restricciones

- Objetivo: una entrada BI con gráficos/desgloses/filtros y KPIs/OKRs persistentes; actividad antigua integrada, sin segunda pantalla. Testimonios y engagement; sin ingresos ni estadísticas segmentadas.
- Admin gestiona definiciones, metas y asignaciones; editor registra avances manuales asignados. Estadística global conserva `stats_v1`, ventanas y opt-in.
- Repo real renombrado a `/home/facundo/dev/testimonial_cms`, mismo remoto No-Country-simulation/S03-26-Equipo-10-Web-App-Development. Base de trabajo `987371f`, checkout inicialmente limpio, rama `codex/bi-unification` creada desde el estado local existente; no se afirma que derive del último main remoto.
- Aplican [AGENTS.md](../../AGENTS.md), skill BI y guías de persistencia/TDD. Ejecutar sólo la fase actual; entregar evidencia y commit sugerido, detenerse para ACK.
- No modificar `schema.prisma`, migraciones previas, infraestructura, manifiesto raíz o hooks; no ejecutar `migrate deploy`/`db push`, aplicar DDL en bases compartidas, desplegar ni guardar secretos/PII. Schema y DDL persistentes requieren sus ACK específicos.
- Fase 1 deja SQL/Prisma propuestos fuera de `prisma/migrations`, sin registro HTTP ni cambio funcional. La pantalla antigua permanece hasta fase 4 y no se declara eliminada antes.

## Decisiones y contrato

[Contrato unificado](../modules/api-bi-unified.md), catálogo ejecutable `contracts/metric-catalog.ts`, validadores `contracts/unified-bi.contract.ts` y tipos `contracts/unified-bi.types.ts` dentro del módulo API BI.

16 métricas, tres tiempos diferenciados: inventario al cierre, eventos por fecha según última reconciliación, creaciones que BI observó. Fuentes sólo afectan engagement; OR intradimensión/AND entre dimensiones. Valores exactos strings/Decimal, desconocidos distintos de cero y comparación previa de igual duración. Etiquetas/primeras observaciones se separarán del cálculo estadístico opcional.

Cuatro entidades OLTP con FK por empresa y auditoría existente. Progreso creciente/decreciente, pesos iguales, cierre congelado y avances inmutables. No introducir objetivos o metas sintéticos en entornos reales.

## Fases

| Fase | Estado | Entrega / aceptación |
| --- | --- | --- |
| 1. Contratos y diseño | Aprobada | Catálogo, validadores/tipos, contrato HTTP/temporal/permisos, borradores SQL/Prisma y verificación offline. Sin activación. |
| 2. Datos y mediciones | Aprobada | Separar datos base de jobs stats; consultas DW, cohortes, filtros, comparaciones y evaluador compartido. PostgreSQL descartable/ACL y benchmark autorizados por separado. |
| 3. Gestión y API | [Actual] | Tras ACK de schema, promover borradores con migración nueva, generar cliente; recursos KPI/OKR/avances, CAS, auditoría, idempotencia, asignaciones y cierre. Nuevos HTTP privados. |
| 4. Interfaz y legado | Pendiente de ACK | Resumen/desgloses/gráficos/filtros, gestión KPI/OKR, Actividad operativa; única entrada BI, redirección y eliminación del feature antiguo, adaptadores compatibles. |
| 5. Aceptación integral | Pendiente de ACK | Recorridos reales admin/editor/dos empresas, escritorio/móvil; caída DW, regresión, migración/ACL/restauración y documentación de habilitación. Sin despliegue remoto. |

Cada fase termina con evidencia y commit sugerido; no marcar la siguiente como actual antes del ACK. Preparar todo el contenido revisable de la fase antes de solicitar aprobación de un paso protegido. Tests sólo contra recursos propios descartables verificados, sin usar DSN implícitos de entornos existentes.

## Matriz de aceptación final

| Riesgo / regla | Evidencia requerida | Fase |
| --- | --- | --- |
| Catálogo y contratos | 16 IDs; unidades/linaje; filtros válidos/repetidos; fechas; decimales exactos; rechazo de tenant/valores inválidos; separación manual/automático | 1 |
| Persistencia propuesta | Prisma combinado temporal validado sin editar schema canónico; diff offline. SQL/checks/trigger/ACL efectivos todavía pendientes | 1 / 3 |
| Semántica y filtrado | Oráculos calculados a mano: tags múltiples sin fan-out, `none`, cohortes históricas, publicaciones vacías, períodos sin cortes, fuentes sólo engagement | 2 |
| Datos base sin stats | Bandera off y entitlement sólo BI siguen capturando taxonomía/creaciones; historial sin marcador explícito; stats mantiene opt-in | 2 |
| Precisión/comparación | CTR >100, vistas cero, previo cero, cobertura insuficiente, medias ponderadas, valores > entero seguro; API/UI/CSV equivalentes | 2 / 4 |
| Autorización | Dos tenants; admin/editor/responsable no asignado; FK SQL compuestas; 404 ajenos; CSRF; entitlements/readonly | 3 / 5 |
| Objetivos | Base/meta crecientes y decrecientes, misma base/meta rechazada, media igualitaria, indisponibilidad global cuando falta un resultado, fecha futura/vencida | 3 |
| Concurrencia e historial | Avances simultáneos/CAS, cierre concurrente, idempotencia, orden de locks, auditoría atómica; trigger bloquea update/delete de avances; cierre inmutable | 3 / 5 |
| Integración antigua | Redirección y único menú; no `features/analytics`; compatibilidad de ambos endpoints anteriores y seguimiento público/scoring intactos | 4 / 5 |
| UI | Filtros/URL/chips, barras seleccionables, tablas/teclado/móvil, errores/estados vacíos/frescura; metas sin cambios por filtros de pantalla | 4 |
| Sistema | API/worker/DW/OLTP/Redis reales propios; admin crea OKR automático/manual, editor avanza, admin cierra; DW caído conserva gestión/actividad/CMS | 5 |

## Evidencia de fase 1

- **Verificado:** catálogo de 16 métricas, contratos de entrada/mediciones y tipos de salida; no hay importación/registro en el módulo HTTP.
- **Red funcional:** la primera versión permisiva produjo 26 fallos y 1 aprobado en 27 casos por ausencia de las restricciones esperadas, no por imports o herramientas rotas. Después se incorporaron dos casos adicionales de fechas resueltas y texto decimal inválido.
- **Green final:** 89/89 casos en seis suites, sin fallos, omisiones ni snapshots: 29 contratos nuevos y 60 de dashboard BI, motor estadístico, lectura estadística, política operativa y dashboard analytics existentes. Ejecución final 4,263 s.
- **Tipos:** `tsc -p tsconfig.json --noEmit --incremental false` API aprobado, sin errores.
- **Lint:** ESLint sobre los tres contratos nuevos y su suite con `--max-warnings 0` aprobado. Se eliminaron los patrones que originaban cinco advertencias iniciales, sin desactivar reglas.
- **Prisma 6.5:** schema propuesto combinado en `/tmp/bi-unified-review.prisma` con una copia del schema y relaciones inversas documentadas: `prisma validate --schema ...` aprobado. `prisma migrate diff --from-schema-datamodel <schema-canónico> --to-schema-datamodel <copia-propuesta> --script` produjo sólo cuatro tablas nuevas, sus índices y FK; no se conectó ni escribió a una base. SQL emitido únicamente en `/tmp`.
- **Revisión documental:** diez archivos nuevos/modificados revisados por espacios finales y enlaces locales; `git diff --check` aprobado. El schema canónico, migraciones activas, registro de módulos HTTP y menú no presentan cambios.
- **Pendiente:** sintaxis/checks/trigger y privilegios efectivos del SQL en PostgreSQL real, migraciones activas, motor de consultas/progreso, controles HTTP, persistencia/API/UI y navegador. Esas pruebas corresponden a fases posteriores con sus ACK; la validación de Prisma no prueba los CHECK ni el trigger manuales.
- **Sin acciones externas:** sin commit, push, despliegue, DDL aplicado, clientes Prisma regenerados, recursos nuevos o cambios al esquema protegido.

Reproducción API desde `apps/api`:

```bash
../../node_modules/.bin/jest --runInBand --runTestsByPath test/bi-unified-contracts.spec.ts test/bi-dashboard.spec.ts test/bi-statistics-engine.spec.ts test/bi-statistics-read.spec.ts test/bi-operations-policy.spec.ts test/analytics-dashboard.spec.ts
../../node_modules/.bin/tsc -p tsconfig.json --noEmit --incremental false
../../node_modules/.bin/eslint src/modules/business-intelligence/contracts/*.ts test/bi-unified-contracts.spec.ts --no-cache --max-warnings 0
```

La copia Prisma es temporal y debe reconstruirse siguiendo las relaciones inversas del fragmento antes de repetir su validación; no se valida el fragmento aislado ni se sustituye el schema canónico. No usar esta evidencia como prueba de DDL aplicado, persistencia, sesión real, habilitación o despliegue.

**Commit sugerido al cerrar fase 1:** `feat(bi): definí los contratos y el modelo de BI unificado`

**Siguiente ACK esperado:** revisión/cierre de fase 1 y autorización de fase 2. La fase 2 no requiere cambiar el schema Prisma; su aplicación para gestión OLTP se revisará antes de fase 3.

## ACK y avance de fase 2

ACK «COntinuar» recibido tras la entrega de fase 1. Autoriza fase 2; no modifica las restricciones de schema, DDL persistente o fases posteriores. Evaluador decimal compartido iniciado; consultas DW, separación ETL y aceptación de datos siguen pendientes.

### Avance verificado de fase 2 (parcial)

Implementados `measurement-engine.ts` (16 métricas, comparación, progreso y promedio con propagación de desconocidos; Decimal local de precisión 80) y `cohort-filter.ts` (predicados parametrizados por tenant/run, semijoins de etiquetas, fuentes separadas y período previo). No están registrados como HTTP. Suite focalizada: 108/108 en ocho archivos, incluidos 19 casos nuevos de aritmética y construcción de filtros. Estas pruebas no ejecutan SQL ni acreditan aislamiento efectivo en PostgreSQL. Continúan pendientes los repositorios que consumen los predicados, series/desgloses/comparación integrados, separación de datos ETL respecto a jobs estadísticos y pruebas de persistencia/ACL/benchmark. Fase 2 permanece [Actual], sin cierre ni solicitud de ACK de fase 3.

### Continuación de fase 2: lectura por período y captura base

Añadido `PeriodMeasurementsRepository`: lectura mediante BiConnection (DW, sólo lectura y snapshot transaccional), corte al cierre solicitado, cohortes parametrizadas, componentes agregados sin fan-out, disponibilidad de taxonomía/creaciones y comparación con período previo. No se registra HTTP aún. Se separó el preflight/captura base de `BI_STATISTICS_ENABLED` en la CLI: los jobs siguen condicionados por esa bandera; publicar datos base sigue sujeto al permiso BI, no al permiso estadístico. El parámetro explícito del publicador para fixtures legadas permanece compatible.

Verificación: 136/136 casos en 12 suites, sin omisiones, incluyendo tres pruebas nuevas de orquestación DW con consultas simuladas y regresión ETL con permiso estadístico ausente. ESLint de archivos afectados con cero advertencias. No se ejecutó SQL/DDL sobre PostgreSQL: los mocks no acreditan sintaxis, ACL ni resultados efectivos. Siguen pendientes series/desgloses/opciones de filtros y aceptación PostgreSQL/benchmark para cerrar fase 2; no solicitar ACK de fase 3 todavía.

### Continuación de fase 2: exploración y series

Añadido `ExplorationRepository` (sin registro HTTP): desgloses por categoría/etiqueta/estado/rating, fuentes, ranking de 20, búsqueda de opciones históricas con total/paginación y series diarias por lote. El inventario diario usa cortes reales de cada día; engagement conserva la cohorte de cierre. Taxonomía ausente queda explícita; los días sin corte no se convierten en inventario cero. El agregado de tags usa pertenencias únicas y eventos previamente agregados por testimonio, evitando fan-out. Medias usan el evaluador decimal compartido.

Verificación: 140/140 casos en 13 suites, sin omisiones; cuatro casos nuevos de orquestación simulan SQL y verifican huecos/ceros, objetos opcionales ausentes, total en página vacía y búsqueda vinculada como parámetro. ESLint afectado con cero advertencias. Estas pruebas no acreditan que PostgreSQL ejecute los SQL ni sus ACL/costo; faltan ejecución real, oráculos por dimensiones y benchmark para aceptar/cerrar fase 2. La composición final de DTO/HTTP corresponde a fase 3. Mantener fase 2 [Actual]; no marcar completada ni solicitar ACK de fase 3.

## Verificación y entrega de fase 2

**Estado:** implementación y aceptación local completadas, pendientes de revisión/ACK de cierre. Las notas parciales anteriores conservan su fecha lógica de avance; esta verificación resuelve la ejecución SQL/ACL y medición que entonces estaban pendientes. No se inició fase 3.

- Integración reproducible `test/bi-unified-local.integration.ts`: opt-in `TEST_BI_UNIFIED_LOCAL=true`; crea un cluster PostgreSQL 18.6 propio en un directorio aleatorio de /tmp mediante initdb, socket Unix privado y TCP desactivado. No recibe DSN de bases compartidas. Instala sólo DW 0001–0005 existentes mediante el migrador de fixtures, publica cortes mediante WarehouseRepository y crea un lector con SELECT/USAGE exclusivamente en dw. Al finalizar desconecta, detiene su proceso y elimina su directorio. La limpieza fue verificada fuera del test. No ejecuta prisma migrate deploy/db push, no modifica schema.prisma ni aplica SQL en destinos persistentes.
- Once casos reales: totales independientes/CTR150; etiquetas múltiples sin fan-out; agregados/ranking; series con hueco; opciones y búsqueda literal/paginación; otra empresa vacía; denegaciones SQL42501 de DML/DDL/control; atributos de cortes históricos; sin categoría y fuentes sólo engagement; BigInt9007199254740993 sin redondeo; lecturas de365d; y corte legado sin marcador de etiquetas. Los permisos de usuario/HTTP y CSRF no se acreditan aquí: corresponden a fase3/5.
- Fixture: tres empresas, seis filas de snapshots de testimonios, diez eventos de origen reconciliados y tres días con cortes/ausencias. Lectura de365d con cinco repeticiones de daily+breakdowns+filterOptions; tiempos agregados en log JSON saneado `bi.unified_local_read_benchmark`. Es un benchmark pequeño, disperso, de consultas reales y caché local, NO prueba de capacidad, concurrencia productiva o independencia de CPU/IO. No se añade un SLO inventado. La volumetría representativa/aceptación productiva permanece fuera de esta evidencia.
- Regresión final:151/151 casos en14 suites, cero fallos/omisiones; once son integración PostgreSQL real, los restantes incluyen contratos/aritmética/SQL simulado/ETL/scheduler/stats/compatibilidad. Tipos API con `tsc --noEmit --incremental false` aprobado. ESLint del test nuevo con `--max-warnings 0` aprobado; archivos de producción afectados ya verificados sin advertencias en las continuaciones previas. `git diff --check` aprobado.
- Reproducción desde apps/api: `TEST_BI_UNIFIED_LOCAL=true ../../node_modules/.bin/jest --runInBand --testRegex=bi-unified-local.integration.ts$ --runTestsByPath test/bi-unified-local.integration.ts`. El entorno debe permitir procesos/sockets locales; el sandbox inicial impidió el inicio de PostgreSQL y la ejecución autorizada fuera del sandbox completó los casos. El fallo de inicio no se cuenta como fallo funcional Red.
- Sin commits/push, dependencias nuevas, clientes Prisma regenerados, endpoints registrados, cambios de UI o infraestructura. La retirada de Analítica permanece en fase4. Se revisarán DTO/composición del API en fase3.

**Commit sugerido de fase2:** `feat(bi): incorporá consultas analíticas y validación real del warehouse`

**Siguiente autorización:** ACK de fase2 y fase3, con ACK explícito para incorporar al schema canónico las cuatro entidades del fragmento Prisma ya revisable. Aplicar DDL persistente conserva una autorización separada; este paso no la solicita ni la necesita para comenzar.

El harness PostgreSQL propio es manual (`.integration.ts`, fuera del patrón `.spec.ts` de Jest), como los benchmarks existentes: CI instala clientes PG18, no initdb/pg_ctl. No añadir una suite omitida al gate CI ni afirmar que la aceptación local haya corrido remotamente. La incorporación al harness CI sin depender de binarios de servidor locales queda para aceptación integral de fase5.

## ACK de fase 3 (2026-11-01)

El usuario respondió «Continuar» a la pregunta explícita que incluía cerrar fase2, iniciar fase3 e incorporar las cuatro entidades del fragmento al schema Prisma. Se acepta ese ACK para el schema; no habilita DDL persistente, fases4–5 o despliegue. Schema incorporado y borrador SQL promovido a migración aditiva20261101000000; no aplicada a destinos existentes.

### Avance parcial de fase 3: modelo y escrituras

- Schema canónico incorpora las cuatro entidades autorizadas y relaciones inversas; migración aditiva `20261101000000_bi_governance` promovida desde el borrador revisado. `prisma validate` y `prisma generate` aprobados con6.5. No se ejecutó migrate deploy/db push ni DDL sobre bases existentes.
- `GovernanceRepository` implementa creación de KPI/objetivo, incorporación de resultado y registro de avance con transacción propia o la transacción suministrada por idempotencia. Comprueba permiso comercial dentro de tx, responsables activos del tenant, locks objetivo→resultado, versiones, definición borrador/límite20, y auditoría atómica sin comentarios/PII en metadata. No está registrado ni expuesto por HTTP todavía.
- `governance-policy.ts`: permisos de admin/editor asignado, tenants, unidad manual, período no futuro, estado activo/manual y conflictos de versión. Estos controles tienen17 tests unitarios; no acreditan por sí solos el flujo completo de roles/HTTP/transacciones concurrentes.
- Regresión focalizada:157/157 en14 suites. ESLint de producción y pruebas nuevas sin advertencias. Cinco tests SQL reales adicionales en harness manual `bi-governance-local.integration.ts`: inicia PostgreSQL18.6 propio en /tmp, padres sintéticos mínimos de tenant/usuario, aplica sólo esta migración mediante psql y valida Prisma/FK/checks/trigger append-only. Detiene y elimina su cluster; limpieza comprobada. No acredita despliegue del schema CMS completo ni AuthService/roles/billing/idempotencia reales.
- Reproducción manual desde apps/api: `TEST_BI_GOVERNANCE_LOCAL=true ../../node_modules/.bin/jest --runInBand --testRegex=bi-governance-local.integration.ts$ --runTestsByPath test/bi-governance-local.integration.ts`. Requiere binarios initdb/pg_ctl/psql y permiso para socket local; queda fuera del patrón de suites CI como los otros harness locales.
- Pendientes de fase3: servicios y DTO finales, lecturas/paginación de gestión, edición, activación/cierre/archivo con captura DW, integración obligatoria de idempotencia, endpoints privados/rate limits y pruebas HTTP/concurrencia/persistencia del flujo completo. No se declara fase3 terminada ni se solicita ACK para fase4.

**Commit sugerido para este avance parcial:** `feat(bi): agregá el modelo y las escrituras transaccionales de objetivos`

### Continuación fase 3: lecturas y ciclo de vida de persistencia

Implementadas lecturas de gestión por tenant con paginación20/orden estable/RepeatableRead, detalle e historial manual; edición de KPIs/objetivos/resultados con CAS y congelamiento semántico de definiciones activas. Se permite cambiar título/responsable activo sin cambiar base/meta/alcance/período/unidad. Transiciones draft→active→closed y archivo; activar un objetivo exige1–20 resultados y responsables activos. El cierre exige captura previa vinculada a ID/versiones del padre y todos los resultados; se almacena definición/evaluación/instante inmutables. El servicio que calculará esa captura DW aún está pendiente, nunca debe construirse desde body HTTP. Locks del padre serializan cambios y cierre; auditoría permanece atómica.

Validación final de este avance:59/59 casos focalizados de contratos/políticas/aritmética; tipos API y ESLint afectado sin errores/advertencias. Once casos reales del harness manual propio: además de FK/checks/append-only, ejecutan GovernanceRepository para creación, activación, avance asignado, cierre y archivo, paginación/historial, auditoría, reasignación, KPIs activos, definiciones congeladas, dos avances concurrentes con un único ganador y captura obsoleta rechazada. Padres sintéticos ampliados con roles/user_roles y audit_logs; billing se simula explícitamente mediante checkMutation, actores son construidos por el test (no JWT/AuthService). No prueba HTTP, idempotencia o enforcement comercial integrado. El cluster privado fue eliminado. Un matcher inicial de permisos esperaba promesa rechazada aunque el guard rechaza antes de crearla; se corrigió para exigir el mismo BI_ADMIN_REQUIRED síncrono, sin cambiar el comportamiento de producción.

Siguen pendientes: servicio de evaluaciones/procedencias y lote de metas automáticas, DTO HTTP, composición del módulo, endpoints privados/rate limits/CSRF, idempotencia obligatoria y aceptación integral del flujo real. La fase3 continúa [Actual]; no solicitar ACK de fase4. No se aplicaron migraciones persistentes ni se modificó UI.

**Commit sugerido de este avance:** `feat(bi): incorporá lecturas y ciclo de vida transaccional de objetivos`

## Entrega y verificación local de fase 3

**Estado:** implementación completada y verificada localmente; pendiente de revisión/ACK para iniciar fase 4. Esta entrega resuelve los pendientes de servicios/HTTP/idempotencia/evaluación anotados en avances anteriores. La aceptación integral con todos los servicios reales continúa en fase 5.

- Registrados controladores privados `/bi/metric-catalog`, `/bi/overview`, `/bi/breakdowns`, `/bi/filter-options`, `/bi/activity` y recursos `/bi/kpis` y `/bi/objectives`, con resultados e historial de avances anidados. JWT/RBAC, DTO estrictos, tenant desde sesión, cuotas existentes y middleware privado se aplican también a errores; CSRF se hereda del límite global. No se cambia `/bi/dashboard` ni `/bi/statistics`.
- Evaluación automática exclusivamente DW, agrupada por alcance guardado en una transacción de lectura; definiciones, composición y valores manuales se leen en un snapshot OLTP consistente. Se conservan corte, reconciliación, cobertura y antigüedad; falta de DW se presenta como indisponibilidad. Un resultado desconocido hace desconocido el avance global, sin ocultar resultados conocidos. Cierre valida versiones padre/hijos y guarda el DTO evaluado con procedencia; las lecturas cerradas y replays no recalculan DW.
- Idempotencia obligatoria en POST, recibos estables y status 200/201; preparación DW fuera de la transacción de escritura y sólo tras buscar respuesta guardada. PATCH usa CAS. Validación de UUID de dimensiones contra catálogo histórico tenant; las fuentes siguen limitadas a engagement. El contrato documenta los bodies anidados y las respuestas reales.
- Actividad consulta explícitamente OLTP, por empresa y con rango/tipo/fuente, paginación20 y orden estable. IDs de eventos son strings exactos incluso sobre el entero seguro JS; fuente normalizada sin filtrar valores libres. Autores/extractos quedan únicamente en la respuesta operativa privada, nunca en DW.
- **184/184 casos en 19 suites**, sin omisiones: API HTTP, evaluación, idempotencia preparada/existente, políticas, contratos, exploración, períodos, precisión, ETL/scheduler, estadísticas, operación y compatibilidad Analytics/dashboard. HTTP usa Nest y JWT/CSRF/RBAC/rate guard reales, con credenciales y almacenamiento de cuotas simulados; incluye rechazo de editor/tenant inyectado/captura inyectada, CSRF, clave obligatoria, UUID, no-store y429. Composición real de BusinessIntelligenceModule verificada sin consultas de gestión en startup.
- **14/14 casos OLTP reales** en harness propio: FK/checks/append-only; roles/asignaciones construidos por fixtures, ciclo de vida, auditoría, reasignación, concurrencia de avances, rechazo de captura obsoleta, idempotencia de altas/avances/cierre y replay con evaluación inaccesible; actividad con22 eventos propios y uno ajeno, filtros y páginas20+2. Ejecuta GovernanceRepository, IdempotencyRepository y servicios reales; padres de CMS sintéticos mínimos, checkMutation comercial simulado y DW simulado indisponible. No acredita AuthService, billing ni CMS completo reales.
- **13/13 casos DW reales**: regresión de semántica histórica/etiquetas/CTR/precisión, ACL del lector, resumen compuesto, comparación sin cobertura y rechazo de UUID de dimensiones ajenas. Benchmark365d de datos sintéticos pequeños/dispersos, cinco muestras finales63–81ms: no prueba capacidad productiva. Las dos integraciones usan clusters PostgreSQL18.6 propios con socket privado/TCP apagado y limpieza al finalizar, sin DSN de bases existentes.
- `tsc -p tsconfig.json --noEmit --incremental false` y tipos de tests aprobados; ESLint de todos los archivos TypeScript modificados/nuevos con `--max-warnings 0` aprobado. Sin dependencias nuevas, cambios de infraestructura, nueva modificación de schema ni nueva migración en esta continuación. No se ejecutó migrate deploy/db push ni DDL persistente, commit, push o despliegue.
- Reproducción desde apps/api: las suites HTTP requieren permiso de socket loopback. `../../node_modules/.bin/jest --runInBand --runTestsByPath test/bi-governance-http.spec.ts test/bi-governance-evaluation.spec.ts test/idempotency-prepared.spec.ts test/idempotency.service.spec.ts` ejecuta el núcleo añadido. Los comandos opt-in de ambos harness PostgreSQL figuran en las secciones anteriores; se mantienen fuera del patrón CI automático y no se presentan como ejecución remota.

**Pendiente:** fase4 (UI unificada, adaptadores de compatibilidad, eliminación de pantalla antigua, gráficos/tablas/CSV) y fase5 (navegador escritorio/móvil, AuthService/billing/Redis/worker/DW reales, caída DW, ACL/migración/restauración y habilitación). No se declara satisfecho aún el resultado global de la unificación.

**Commit sugerido:** `feat(bi): conectá la API y la evaluación idempotente de objetivos`

**Siguiente ACK:** revisar/cerrar fase3 y autorizar fase4 de interfaz y retirada de Analítica. La aplicación persistente de migraciones conserva autorización separada y no es necesaria para revisar este código.

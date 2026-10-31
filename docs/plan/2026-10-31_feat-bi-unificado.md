# Unificación y ampliación de BI

**Fecha:** 2026-10-31. **Estado:** fase 1 aprobada; fase 2 [Actual] implementada y verificada localmente; cierre y fases 3–5 pendientes de ACK.

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
| 2. Datos y mediciones | [Actual] | Separar datos base de jobs stats; consultas DW, cohortes, filtros, comparaciones y evaluador compartido. PostgreSQL descartable/ACL y benchmark autorizados por separado. |
| 3. Gestión y API | Pendiente de ACK | Tras ACK de schema, promover borradores con migración nueva, generar cliente; recursos KPI/OKR/avances, CAS, auditoría, idempotencia, asignaciones y cierre. Nuevos HTTP privados. |
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

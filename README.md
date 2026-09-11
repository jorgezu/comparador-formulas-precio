# Comparador de fórmulas de valoración del precio

Herramienta web pública para calcular un mismo escenario con siete familias de fórmulas de valoración del criterio precio y comparar su rango efectivo, sensibilidad, variantes y dependencia del conjunto de ofertas.

El análisis es matemático y descriptivo. No sustituye el análisis jurídico ni determina por sí mismo la idoneidad de una fórmula para un expediente concreto.

## Ejecución local

Requiere Python 3.10 o posterior.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-public.txt
FORMULA_PUBLIC_ALLOWED_HOSTS=localhost,127.0.0.1 PYTHONPATH=src .venv/bin/python -m cepos.formula_web.server
```

La aplicación queda disponible en `http://127.0.0.1:8000/formulas`.

## Docker

```bash
docker build -f Dockerfile.public -t comparador-formulas-precio .
docker run --rm -p 8000:8000 -e FORMULA_PUBLIC_ALLOWED_HOSTS=localhost,127.0.0.1 comparador-formulas-precio
```

## Render

`render.yaml` configura un Web Service Docker en Frankfurt y utiliza `/health` para comprobar el servicio. El puerto se obtiene de la variable `PORT` proporcionada por la plataforma.

## Variables de entorno

| Variable | Obligatoria | Uso |
|---|---:|---|
| `FORMULA_PUBLIC_ALLOWED_HOSTS` | Sí en producción | Lista de hosts admitidos, separados por comas. |
| `PORT` | No | Puerto HTTP. Por defecto `8000`. |
| `FORMULA_LINKEDIN_URL` | No | Enlace público de LinkedIn del autor. |
| `FORMULA_WEBSITE_URL` | No | Web pública del autor. |
| `FORMULA_FEEDBACK_URL` | No | URL `https://` o `mailto:` para comentarios. |

Si no se configuran los enlaces opcionales, no se muestran en la interfaz. Ninguna variable secreta es necesaria para ejecutar la herramienta.

## Privacidad y aislamiento

- Los escenarios se calculan en memoria y no se persisten.
- No hay rastreadores, cookies ni llamadas a terceros.
- El servidor sólo expone la herramienta, su API de cálculo, dos archivos estáticos y `/health`.
- No incluye CePOS Manager, bases de datos, índices, documentos privados ni rutas locales.

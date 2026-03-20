# BibMan

**BibMan** es un plugin para [Obsidian](https://obsidian.md) diseñado para autores, investigadores y estudiantes que necesitan gestionar referencias bibliográficas de forma sencilla y directa dentro de sus notas.

Este plugin permite insertar y visualizar citas bibliográficas utilizando una sintaxis intuitiva, facilitando la conexión entre tus textos y tus fuentes de referencia.

## Características

- **Citas Inline**: Utiliza la sintaxis `{{citekey}}` para insertar una referencia rápida.
- **Soporte para Páginas**: Permite especificar rangos de páginas o capítulos usando `{{citekey:pag-pag}}`.
- **Visualización Dinámica**: Transforma las claves de citación en elementos visuales (superíndices) dentro de la vista de lectura de Obsidian.
- **Popups de Información**: Al pasar el ratón sobre una cita, se muestra información detallada de la fuente en un popup.
- **Actualización Automática**: El plugin gestiona el barrido y la actualización de la numeración de las citas en el documento.

## Instalación

### Instalación manual
1. Descarga la última versión (`main.js`, `manifest.json` y `styles.css`) desde la sección de [Releases](https://github.com/sanhuesoft/bibman/releases).
2. Crea una carpeta llamada `bibman` dentro de `.obsidian/plugins/` en tu bóveda.
3. Copia los archivos descargados en esa carpeta.
4. Activa el plugin desde la configuración de **Community plugins** en Obsidian.

## Uso

Para insertar una cita, simplemente escribe el identificador de tu fuente entre llaves dobles:

- `{{Sanhueza2026}}` se convertirá en una referencia a esa clave.
- `{{Sanhueza2026:12-15}}` creará una referencia apuntando específicamente a las páginas 12 a 15.

## Configuración

El plugin buscará por defecto una carpeta llamada **Bibliografía** en la raíz de tu bóveda para extraer los metadatos de las referencias. Puedes personalizar el nombre de esta carpeta en los ajustes del plugin.

## Autor

Desarrollado por **Fabián Sanhueza Vásquez**.
Sitio web: [https://www.fabiansanhueza.cl](https://www.fabiansanhueza.cl).

---
Si te gusta este plugin, considera apoyarme en [Ko-fi](https://www.ko-fi.com/sanhuesoft).
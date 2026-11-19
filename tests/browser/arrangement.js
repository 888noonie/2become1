export async function openArrangement(page) {
  const summary = page.getByText('Arrangement & rendering', {exact:true});
  if (!await summary.evaluate(el => el.parentElement.open)) await summary.click();
}

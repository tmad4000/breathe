export async function chooseSession(page,kind,value){
 await page.click(kind==='pattern'?'#quickPattern':'#quickPace');
 const keys=kind==='pattern'?['5-1-5-1','5-0-5','4-7-8']:['0','5','5.5','6','8','10','12','15','20'];
 await page.locator('#sessionMenu button').nth(keys.indexOf(value)).click();
}

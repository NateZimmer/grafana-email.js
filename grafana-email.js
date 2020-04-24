/**
 * @file grafana-email.js
 * @author Nathan Zimmerman
 * @abstract Sends email based reports 
 * @license MIT
 * @example node grafana-email.js -file sample_report.json
 */

// Packages 
const nodemailer = require("nodemailer");
const axios = require('axios');
const fs = require('fs');
var readline = require('readline');
const rl = readline.createInterface({ input: process.stdin , output: process.stdout });

// Report Parameters
var _height = 500;
var _width = 1000;
var _time_range_start = 'now-2d';
var _time_range_end = 'now';

// Globals 
var argList = {file:''};
var json_settings = null;
var transporter = null;
var attachments = [];
var email_body ='';
var retry_limit = 10;
var min_image_size = 10000;

// Functions 
let sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @description Process required input arguments in argList  
 */
function process_cmd_input(){
  var arg_check_fail = false; 
  for(arg in argList){
      var argI = process.argv.indexOf('-'+arg);
      if(argI == -1){
          console.log('You must specify the -'+arg+' argument.');
          arg_check_fail = true;
      }else{
          var val = process.argv[argI + 1];
          argList[arg] = val;
          console.log(arg + ' : ' + val);
      }
  }
  if(arg_check_fail){
      throw('Missing required input arguments');
  }
  site_location = argList.site;
  input_name = argList.input;
}
process_cmd_input();

/**
 * @description Used for CLI prompt in test emails   
 */
const getLine = (function () {
  const getLineGen = (async function* () {
      for await (const line of rl) {
          yield line;
      }
  })();
  return async () => ((await getLineGen.next()).value);
})();


/**
 * @description Reads/parses cli provided report.json   
 */
function read_report_file(file_path){
  
  var json_settings = null;
  if(!fs.existsSync(file_path)){
    throw(`File at ${file_path} does not exist`);
  }
  
  var file_text = fs.readFileSync(file_path);
  
  try{
    json_settings = JSON.parse(file_text);
  }catch(e){
    console.log(e);
    throw('Invalid setting file');
  }
  return json_settings;
}
json_settings = read_report_file(argList.file);


/**
 * @description Sets up nodemailer transport  
 */
function setup_transport(){
  transporter = nodemailer.createTransport({
    host: json_settings.smtp_host,
    port: json_settings.smtp_port,
    secure: true,
    auth: {
      user: json_settings.smtp_user, 
      pass: json_settings.smtp_password
    }
  });
}
setup_transport();

/**
 * @description Formulates api url based on settings / panel info  
 */
function get_req_url(panel_obj){
  var req_url =`${json_settings.server_url}/render/d-solo/`;
  req_url += (panel_obj.dashboard_id ? panel_obj.dashboard_id : json_settings.dashboard_id )+'/';
  req_url += (panel_obj.dashboard_name ? panel_obj.dashboard_name.toLocaleLowerCase() : json_settings.dashboard_name.toLocaleLowerCase())+'?';
  req_url += 'from=' + ( json_settings.time_start ? json_settings.time_start :_time_range_start) + '&';
  req_url += 'to=' + ( json_settings.time_end ? json_settings.time_end :_time_range_end)  + '&';
  req_url += 'panelId=' + panel_obj.id + '&';
  req_url += 'width=' + (panel_obj.width ? panel_obj.width : _width) + '&';
  req_url += 'height=' + (panel_obj.height ? panel_obj.height : _height); 
  return req_url;
}

/**
 * @description Performs a GET request against API for an image. returns results as base64  
 */
async function get_base64_image(url,token) {
  var headers = (token.length) ? {Authorization:`Bearer ${token}`} : {}; 
  var res = await axios.get(url, {responseType: 'arraybuffer',headers: headers});
  return Buffer.from(res.data, 'binary').toString('base64');
}

/**
 * @description Too long clobber function that pulls the images while creating the email body then sends the emails.  
 */
async function generate_report(){
  email_body += `<h3>${json_settings.title}</h3>\r\n`;
  email_body += `<b>Contact:</b> ${json_settings.sender_contact}<br>\r\n`;
  email_body += '<b>Date:</b> ' + Date(Date.now()) + '<br><br>\r\n\r\n';
  email_body += `${json_settings.intro_text}<br>\r\n`;
  var date_now = Date.now();
  for(var panel of json_settings.panel_list){
    var req_url = get_req_url(panel);
    await sleep(1000);
    for(var i = 0; i < retry_limit; i++){
      console.log(`Downloading image id: ${panel.id} via url: ${req_url}`);
      var image_content = await get_base64_image(req_url,json_settings.grafana_api_token);
      if(image_content.length > min_image_size){
        console.log(`Download finished. Size: ${image_content.length}`);
        break;
      }else{
        console.log(`Download finished.[Failed size check, retrying] Size: ${image_content.length}`);
      }
      await sleep(1000);
    }
    
    var image_id = 'image_' + panel.id + '_' + date_now;
    var att_obj = {};
    att_obj.filename = image_id + '.png';
    att_obj.encoding = 'base64';
    att_obj.content = image_content;
    att_obj.cid = image_id;
    attachments.push(att_obj);
    email_body += `<br>\r\n<b>Info: </b> ${panel.desc} <br>\r\n <img src="cid:${image_id}" /> <br>\r\n`
  }
  email_body += '<br>\r\n' + json_settings.footer_text;

  console.log('Finished collection images');

  if(json_settings._test_email){ // Has a test email been entered? 
    console.log('Sending test email');
    let info = await transporter.sendMail({
      from: json_settings.smtp_user,
      to: json_settings._test_email, 
      attachments: attachments,
      subject: json_settings.email_subject,
      html:email_body
    });

    console.log("Message sent: %s", info.messageId);
    for(var i = 0; i < 10; i++){
      console.log('Do you wish to send this email to ' + json_settings.email_list);
      console.log('yes,no?');
      var res = await getLine();
      if(res.toLocaleLowerCase().includes('yes')){
        break;
      }else if(res.toLocaleLowerCase().includes('no')){
        console.log('User aborted sending email');
        process.exit(0);
      }
    }
  }

  let main_email = await transporter.sendMail({
    from: json_settings.smtp_user,
    to: json_settings.email_list, 
    attachments: attachments,
    subject: json_settings.email_subject,
    html:email_body
  });
  console.log("Main Email sent: %s", main_email.messageId);


  process.exit(0);

}

// Main program entry 
generate_report();

